// The read-only browse page: an HTML shell at / and /people/<id>, and a small
// JSON API it reads from. Both need a Google sign-in session. Nothing here
// writes to the CRM; changes go through Claude.

import * as crm from './crm.mjs';
import { json, methodNotAllowed } from './http.mjs';
import { userForSession } from './oauth.mjs';
import { appShell, signInPage } from './pages.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const SORTS = { name: 'name', recent: 'recently_contacted', oldest: 'least_recently_contacted' };

export async function page(db, request) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const me = await userForSession(db, request);
  if (!me) {
    const { pathname, search } = new URL(request.url);
    return signInPage(pathname + search);
  }
  return appShell(me);
}

// The date `days` days before today, in the team's time zone.
function daysAgo(days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: crm.timezone() }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// /api/people?q=&tag=&tag=&relationship=&organization=&owner=&stale=<days>&never=1&sort=name|recent|oldest&offset=
function searchInput(params) {
  const input = { limit: PAGE_SIZE, sort: SORTS[params.get('sort')] || 'name' };
  const q = params.get('q')?.trim();
  if (q) input.query = q;
  const tags = params.getAll('tag').filter(Boolean);
  if (tags.length) input.tags = tags;
  if (crm.RELATIONSHIPS.includes(params.get('relationship'))) input.relationship = params.get('relationship');
  if (params.get('organization')) input.organization = params.get('organization');
  if (params.get('owner')) input.owner = params.get('owner');
  const stale = Number(params.get('stale'));
  if (Number.isInteger(stale) && stale > 0) input.not_contacted_since = daysAgo(stale);
  if (params.get('never') === '1') input.never_contacted = true;
  const offset = Number(params.get('offset'));
  if (Number.isInteger(offset) && offset > 0) input.offset = offset;
  return input;
}

async function personPage(db, me, id) {
  const person = await crm.getPerson(db, me, { person: id });
  const { interactions } = await crm.listInteractions(db, me, { person: id, limit: 200 });
  const { actions } = await crm.listActions(db, me, { person: id, status: 'open', limit: 200 });
  const { recent_interactions, open_actions, ...details } = person;
  return { ...details, interactions, actions };
}

export async function api(db, request) {
  const me = await userForSession(db, request);
  if (!me) return json(401, { error: 'Sign in first.' });
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  try {
    if (path === '/api/me') return json(200, { name: me.name, email: me.email });
    if (path === '/api/filters') return json(200, await crm.filterOptions(db));
    if (path === '/api/people') return json(200, await crm.searchPeople(db, me, searchInput(url.searchParams)));
    const match = /^\/api\/people\/([^/]+)$/.exec(path);
    if (match) {
      if (!UUID_RE.test(match[1])) return json(404, { error: 'No such person.' });
      return json(200, await personPage(db, me, match[1]));
    }
    return json(404, { error: 'Not found.' });
  } catch (err) {
    if (err instanceof crm.UserError) {
      return json(/^No person matches/.test(err.message) ? 404 : 400, { error: err.message });
    }
    throw err;
  }
}
