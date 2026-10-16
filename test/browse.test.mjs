// The read-only browse page: Google sign-in with a session cookie, the page
// shell, and the JSON API it reads from.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as crmApi from '../src/crm.mjs';
import { BASE, cookieFrom, startCrm, teammateClaims } from './helpers.mjs';

let crm;
let session; // "__Host-crm_session=..." for Lee
let people;

const leeClaims = teammateClaims('lee@example.com', 'Lee Test');

function daysAgo(days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: crmApi.timezone() }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  crm = await startCrm();
  const { db } = crm;
  const pat = (await db.query("insert into users (email, name) values ('pat@example.com', 'Pat Example') returning id, name, email")).rows[0];
  const add = (input) => crmApi.addPerson(db, pat, { create_new_tags: true, confirm_new: true, ...input });
  people = {
    ada: await add({
      name: 'Ada Ray',
      organization: 'Acme Labs',
      relationship: 'collaborating',
      owner: 'pat@example.com',
      notes: 'Line one.\nLine two.',
      tags: [
        { tag: 'Robotics', useful_for: 'Builds tactile grippers.' },
        { tag: 'Fiber Drawing', useful_for: 'Knows fiber drawing rigs.' },
      ],
    }),
    ben: await add({ name: 'Ben Ito', organization: 'Acme Labs', tags: [{ tag: 'Robotics', useful_for: 'Soft actuators.' }] }),
    cy: await add({ name: 'Cy Moss', organization: 'NSF', relationship: 'want_to_collaborate' }),
    dee: await add({ name: 'Dee Park' }),
  };
  await crmApi.logInteraction(db, pat, { people: ['Ada Ray'], type: 'meeting', summary: 'Recent coffee', date: daysAgo(10) });
  await crmApi.logInteraction(db, pat, { people: ['Ben Ito', 'Ada Ray'], type: 'call', summary: 'Old call', date: daysAgo(100) });
  for (let i = 0; i < 25; i++) {
    await crmApi.logInteraction(db, pat, { people: ['Ada Ray'], type: 'email_sent', summary: `Email ${i}`, date: daysAgo(200 + i) });
  }
  await crmApi.addAction(db, pat, {
    title: 'Send Ada the pilot plan',
    type: 'email',
    person: 'Ada Ray',
    due_date: daysAgo(-7),
    draft_subject: 'Pilot plan',
    draft_body: 'Hi Ada,\nHere it is.',
  });
  const done = await crmApi.addAction(db, pat, { title: 'Already done', person: 'Ada Ray' });
  await crmApi.updateAction(db, pat, { action_id: done.id, status: 'done' });

  const { response } = await crm.signInWithGoogle(`${BASE}/login?next=${encodeURIComponent('/?tag=Robotics')}`, leeClaims);
  session = cookieFrom(response, '__Host-crm_session');
});

const get = (path, cookie = session) => crm.request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
const getJson = async (path) => {
  const res = await get(path);
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return res.json();
};
const names = (result) => result.people.map((p) => p.name);

test('without signing in, the page asks you to sign in and the API refuses', async () => {
  const page = await get('/people/abc', null);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Sign in with Google/);
  assert.match(body, /href="\/login\?next=%2Fpeople%2Fabc"/);
  assert.doesNotMatch(body, /app\.js/);
  assert.equal((await get('/api/people', null)).status, 401);
  assert.equal((await get('/api/people', '__Host-crm_session=crmsess_made-up')).status, 401);
});

test('signing in sets an httpOnly, Secure, SameSite=Lax session cookie and returns to the page you wanted', async () => {
  const { response } = await crm.signInWithGoogle(`${BASE}/login?next=${encodeURIComponent('/people/x?y=1')}`, leeClaims);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/people/x?y=1');
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('__Host-crm_session='));
  assert.match(cookie, /; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  // Signing in added Lee as a teammate.
  assert.deepEqual(await getJson('/api/me'), { name: 'Lee Test', email: 'lee@example.com' });

  // Somewhere off this site is never a place to return to.
  for (const next of ['//evil.example/x', '/\\evil.example', '/\t/evil.example', 'https://evil.example']) {
    const elsewhere = await crm.signInWithGoogle(`${BASE}/login?next=${encodeURIComponent(next)}`, leeClaims);
    assert.equal(elsewhere.response.headers.get('location'), '/', next);
  }
  // Already signed in: /login goes straight on.
  const again = await get('/login?next=/people/z');
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), '/people/z');
});

test('accounts outside @example.com get no session', async () => {
  const { response } = await crm.signInWithGoogle(`${BASE}/login`, teammateClaims('pal@gmail.com', 'Pal', { hd: undefined }));
  assert.equal(response.status, 403);
  assert.equal(cookieFrom(response, '__Host-crm_session'), null);
  assert.match(await response.text(), /Choose another account/);
});

test('signed in, the page is the app shell, locked down', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(body, /Lee Test/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal((await get(`/people/${people.ada.id}`)).status, 200);
});

test('the people list shows organization, tags with notes, relationship, owner and last contact', async () => {
  const all = await getJson('/api/people');
  assert.equal(all.total, 4);
  assert.deepEqual(names(all), ['Ada Ray', 'Ben Ito', 'Cy Moss', 'Dee Park']);
  const ada = all.people[0];
  assert.equal(ada.organization, 'Acme Labs');
  assert.equal(ada.relationship, 'collaborating');
  assert.equal(ada.owner, 'Pat Example');
  assert.deepEqual(ada.tags[1], { tag: 'Robotics', useful_for: 'Builds tactile grippers.' });
  assert.deepEqual(ada.last_contacted, { date: daysAgo(10), type: 'meeting', logged_by: 'Pat Example' });
});

test('filters combine: tags (all must match), relationship, organization, owner, search', async () => {
  assert.deepEqual(names(await getJson('/api/people?tag=Robotics')), ['Ada Ray', 'Ben Ito']);
  assert.deepEqual(names(await getJson('/api/people?tag=Robotics&tag=Fiber%20Drawing')), ['Ada Ray']);
  assert.deepEqual(names(await getJson('/api/people?relationship=want_to_collaborate')), ['Cy Moss']);
  const { organizations } = await getJson('/api/filters');
  const spec = organizations.find((o) => o.name === 'Acme Labs');
  assert.equal(spec.people, 2);
  assert.deepEqual(names(await getJson(`/api/people?organization=${spec.id}&relationship=in_touch`)), ['Ben Ito']);
  assert.deepEqual(names(await getJson('/api/people?owner=pat%40example.com')), ['Ada Ray']);
  assert.deepEqual(names(await getJson('/api/people?q=actuators')), ['Ben Ito']);
  const unknownTag = await get('/api/people?tag=Robots');
  assert.equal(unknownTag.status, 400);
  assert.match((await unknownTag.json()).error, /Similar: "Robotics"/);
});

test('contact filters and sorting', async () => {
  // Not contacted in 30 days: Ben (100 days ago) and the two never contacted.
  assert.deepEqual(names(await getJson('/api/people?stale=30')), ['Ben Ito', 'Cy Moss', 'Dee Park']);
  assert.deepEqual(names(await getJson('/api/people?stale=365')), ['Cy Moss', 'Dee Park']);
  assert.deepEqual(names(await getJson('/api/people?never=1')), ['Cy Moss', 'Dee Park']);
  assert.deepEqual(names(await getJson('/api/people?sort=recent')), ['Ada Ray', 'Ben Ito', 'Cy Moss', 'Dee Park']);
  assert.deepEqual(names(await getJson('/api/people?sort=oldest')), ['Cy Moss', 'Dee Park', 'Ben Ito', 'Ada Ray']);
  const page2 = await getJson('/api/people?offset=3');
  assert.equal(page2.total, 4);
  assert.deepEqual(names(page2), ['Dee Park']);
});

test('a person page has details, tags, notes, the whole history and open follow-ups with drafts', async () => {
  const ada = await getJson(`/api/people/${people.ada.id}`);
  assert.equal(ada.notes, 'Line one.\nLine two.');
  assert.equal(ada.tags.length, 2);
  assert.equal(ada.interactions.length, 27);
  assert.deepEqual(ada.interactions.slice(0, 2).map((i) => [i.summary, i.logged_by]), [['Recent coffee', 'Pat Example'], ['Old call', 'Pat Example']]);
  assert.deepEqual(ada.interactions[1].people.map((p) => p.name), ['Ada Ray', 'Ben Ito']);
  assert.equal(ada.interactions.at(-1).summary, 'Email 24');
  assert.deepEqual(ada.actions.map((a) => [a.title, a.status, a.draft_subject, a.draft_body]), [
    ['Send Ada the pilot plan', 'suggested', 'Pilot plan', 'Hi Ada,\nHere it is.'],
  ]);
  assert.equal(ada.recent_interactions, undefined);
  assert.equal((await get('/api/people/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await get('/api/people/Ada%20Ray')).status, 404);
});

test('filter choices list tags with counts, organizations and teammates', async () => {
  const choices = await getJson('/api/filters');
  assert.deepEqual(choices.tags.map((t) => [t.name, t.people]), [['Fiber Drawing', 1], ['Robotics', 2]]);
  assert.deepEqual(choices.organizations.map((o) => o.name), ['Acme Labs', 'NSF']);
  assert.ok(choices.teammates.some((t) => t.email === 'lee@example.com'));
});

test('the API only reads', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await crm.request(`${BASE}/api/people/${people.ada.id}`, { method, headers: { cookie: session } });
    assert.equal(res.status, 405, method);
  }
  assert.equal((await crm.request(`${BASE}/logout`)).status, 405); // signing out needs a POST
});

test('signing out ends the session', async () => {
  const { response } = await crm.signInWithGoogle(`${BASE}/login`, leeClaims);
  const mine = cookieFrom(response, '__Host-crm_session');
  assert.equal((await get('/api/me', mine)).status, 200);
  const out = await crm.request(`${BASE}/logout`, { method: 'POST', headers: { cookie: mine } });
  assert.equal(out.status, 303);
  assert.match(out.headers.getSetCookie()[0], /^__Host-crm_session=; Path=\/; Max-Age=0/);
  assert.equal((await get('/api/me', mine)).status, 401);
  assert.equal((await get('/api/me')).status, 200); // other sessions are untouched
});
