// Everything the CRM can do. Each function takes the database, the teammate
// making the request (`me`), and plain input, and returns plain data.
// Problems the caller can fix (unknown person, likely duplicate, bad date)
// throw UserError with a message written for Claude to act on.

export class UserError extends Error {}

export const RELATIONSHIPS = ['collaborating', 'want_to_collaborate', 'in_touch'];
export const ORG_TYPES = ['funder', 'investor', 'customer', 'partner', 'supplier', 'research', 'other'];
export const INTERACTION_TYPES = ['meeting', 'call', 'email_sent', 'email_received', 'message', 'event'];
export const ACTION_TYPES = ['email', 'follow_up', 'meeting', 'other'];
export const ACTION_STATUSES = ['suggested', 'approved', 'done', 'dismissed'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Dates are shown and entered in the team's local time zone.
export function timezone() {
  return process.env.CRM_TIMEZONE || 'America/Los_Angeles';
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone() }).format(new Date());
}

// Builds a numbered parameter list alongside the SQL text.
class Params {
  constructor() {
    this.values = [];
    this.tzRef = null;
  }
  add(value) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  tz() {
    if (!this.tzRef) this.tzRef = this.add(timezone()) + '::text';
    return this.tzRef;
  }
  // A timestamp column as a local YYYY-MM-DD date.
  day(column) {
    return `to_char(timezone(${this.tz()}, ${column}), 'YYYY-MM-DD')`;
  }
  // Local midnight at the start of a YYYY-MM-DD date.
  startOfDay(date) {
    return `timezone(${this.tz()}, ${this.add(date)}::date::timestamp)`;
  }
}

// ---------------------------------------------------------------- input helpers

function text(value) {
  return value == null ? value : String(value).trim();
}

function textOrNull(value) {
  const t = text(value);
  return t ? t : null;
}

function required(value, field) {
  const t = text(value);
  if (!t) throw new UserError(`${field} is required.`);
  return t;
}

function date(value, field) {
  const t = text(value);
  if (!DATE_RE.test(t) || Number.isNaN(Date.parse(t))) {
    throw new UserError(`${field} must be a date like 2026-10-15.`);
  }
  return t;
}

function limit(value, fallback, max) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(n, 1), max);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// ---------------------------------------------------------------- duplicate detection

function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

// "Robotics" ~ "Robots", "Fiber Drawing" ~ "Fiber Drawing project", "Acme Labs" ~ "AcmeLabs Inc."
export function isSimilar(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  return levenshtein(x, y) <= (Math.max(x.length, y.length) <= 6 ? 1 : 2);
}

// Adds "Ben Smith" ~ "Benjamin Smith" on top of isSimilar.
function isSimilarPersonName(a, b) {
  if (isSimilar(a, b)) return true;
  const x = normalizeName(a).split(' ');
  const y = normalizeName(b).split(' ');
  if (x.length < 2 || y.length < 2 || x.at(-1) !== y.at(-1)) return false;
  return x[0].startsWith(y[0]) || y[0].startsWith(x[0]);
}

// ---------------------------------------------------------------- lookups

async function resolvePerson(db, ref) {
  const r = required(ref, 'person');
  let rows;
  if (UUID_RE.test(r)) {
    rows = (await db.query('select id, name from people where id = $1', [r])).rows;
  } else if (r.includes('@')) {
    rows = (await db.query('select id, name from people where lower(email) = lower($1)', [r])).rows;
  } else {
    rows = (
      await db.query(
        `select p.id, p.name, o.name as organization
         from people p left join organizations o on o.id = p.organization_id
         where lower(p.name) = lower($1)`,
        [r],
      )
    ).rows;
  }
  if (rows.length === 1) return rows[0];
  if (!rows.length) {
    throw new UserError(`No person matches "${r}". Use search_people to find them, or add_person to add them.`);
  }
  const list = rows.map((p) => `${p.name}${p.organization ? ` (${p.organization})` : ''} [${p.id}]`).join('; ');
  throw new UserError(`More than one person is named "${r}": ${list}. Use the ID.`);
}

async function resolveOrg(db, ref) {
  const r = required(ref, 'organization');
  const { rows } = UUID_RE.test(r)
    ? await db.query('select id, name from organizations where id = $1', [r])
    : await db.query('select id, name from organizations where lower(name) = lower($1)', [r]);
  if (rows[0]) return rows[0];
  const similar = await similarOrgs(db, r);
  throw new UserError(
    `No organization is named "${r}".` +
      (similar.length ? ` Similar: ${similar.map((o) => `"${o.name}"`).join(', ')}.` : '') +
      ' Use search_organizations to find it.',
  );
}

async function similarOrgs(db, name) {
  const { rows } = await db.query('select id, name from organizations');
  return rows.filter((o) => isSimilar(o.name, name));
}

async function findOrCreateOrg(db, me, ref, confirmNew) {
  const r = required(ref, 'organization');
  const { rows } = UUID_RE.test(r)
    ? await db.query('select id, name from organizations where id = $1', [r])
    : await db.query('select id, name from organizations where lower(name) = lower($1)', [r]);
  if (rows[0]) return rows[0];
  if (UUID_RE.test(r)) throw new UserError(`No organization has the ID ${r}.`);
  if (!confirmNew) {
    const similar = await similarOrgs(db, r);
    if (similar.length) {
      throw new UserError(
        `"${r}" isn't in the CRM, but these organizations look similar: ` +
          similar.map((o) => `"${o.name}"`).join(', ') +
          `. Use one of those names, or repeat with confirm_new_organization: true to add "${r}" as a new organization.`,
      );
    }
  }
  return (
    await db.query(
      'insert into organizations (name, created_by, updated_by) values ($1, $2, $2) returning id, name',
      [r, me.id],
    )
  ).rows[0];
}

async function resolveUser(db, ref, me) {
  const r = required(ref, 'teammate');
  if (r.toLowerCase() === 'me') return me;
  const { rows } = UUID_RE.test(r)
    ? await db.query('select id, name, email from users where id = $1', [r])
    : await db.query('select id, name, email from users where lower(email) = lower($1) or lower(name) = lower($1)', [r]);
  if (rows.length === 1) return rows[0];
  const team = (await db.query('select name, email from users order by name')).rows;
  throw new UserError(
    `No single teammate matches "${r}". Teammates: ${team.map((u) => `${u.name} <${u.email}>`).join(', ')}.`,
  );
}

async function findTag(db, name) {
  return (await db.query('select id, name from tags where lower(name) = lower($1)', [name])).rows[0] || null;
}

async function similarTags(db, name) {
  const { rows } = await db.query('select id, name from tags');
  return rows.filter((t) => isSimilar(t.name, name));
}

async function requireTag(db, ref) {
  const name = required(ref, 'tag');
  const tag = await findTag(db, name);
  if (tag) return tag;
  const similar = await similarTags(db, name);
  throw new UserError(
    `No tag is named "${name}".` +
      (similar.length ? ` Similar: ${similar.map((t) => `"${t.name}"`).join(', ')}.` : '') +
      ' Use list_tags to see them all.',
  );
}

async function findOrCreateTag(db, me, ref, createNew) {
  const name = required(ref, 'tag');
  if (name.length > 60) throw new UserError('Tag names must be 60 characters or fewer.');
  const tag = await findTag(db, name);
  if (tag) return tag;
  if (!createNew) {
    const similar = await similarTags(db, name);
    const hint = similar.length
      ? ` These existing tags look similar: ${similar.map((t) => `"${t.name}"`).join(', ')}. Use one of them if it fits.`
      : '';
    throw new UserError(
      `There's no tag named "${name}" yet.${hint} To create "${name}" as a new tag, repeat with create_new_tag: true.`,
    );
  }
  return (await db.query('insert into tags (name, created_by) values ($1, $2) returning id, name', [name, me.id])).rows[0];
}

// ---------------------------------------------------------------- team

export async function whoami(db, me) {
  const { rows } = await db.query('select name, email from users order by name');
  return { you: { name: me.name, email: me.email }, team: rows, timezone: timezone(), today: today() };
}

// ---------------------------------------------------------------- people

function personSelect(p, extraColumns = '') {
  return `
    select p.id, p.name, p.email, p.role, p.relationship, p.how_we_met, p.notes,
      o.name as organization, ow.name as owner,
      coalesce((
        select json_agg(json_build_object('tag', t.name, 'useful_for', pt.useful_for) order by lower(t.name))
        from person_tags pt join tags t on t.id = pt.tag_id
        where pt.person_id = p.id
      ), '[]'::json) as tags,
      lc.date as last_contact_date, lc.type as last_contact_type, lc.by as last_contact_by,
      cb.name as added_by, ${p.day('p.created_at')} as added_on,
      ub.name as updated_by, ${p.day('p.updated_at')} as updated_on
      ${extraColumns}
    from people p
    left join organizations o on o.id = p.organization_id
    left join users ow on ow.id = p.owner_id
    left join users cb on cb.id = p.created_by
    left join users ub on ub.id = p.updated_by
    left join lateral (
      select i.occurred_at, ${p.day('i.occurred_at')} as date, i.type, u.name as by
      from interaction_people ip
      join interactions i on i.id = ip.interaction_id
      left join users u on u.id = i.logged_by
      where ip.person_id = p.id
      order by i.occurred_at desc
      limit 1
    ) lc on true`;
}

function lastContact(row) {
  return row.last_contact_date
    ? { date: row.last_contact_date, type: row.last_contact_type, logged_by: row.last_contact_by }
    : null;
}

function personSummary(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    organization: row.organization,
    role: row.role,
    relationship: row.relationship,
    owner: row.owner,
    tags: row.tags,
    last_contacted: lastContact(row),
  };
}

export async function searchPeople(db, me, input = {}) {
  const p = new Params();
  const where = [];
  const query = text(input.query);
  if (query) {
    const q = p.add(`%${escapeLike(query)}%`);
    where.push(`(p.name ilike ${q} or p.email ilike ${q} or p.role ilike ${q} or p.notes ilike ${q}
      or p.how_we_met ilike ${q} or o.name ilike ${q}
      or exists (select 1 from person_tags pt join tags t on t.id = pt.tag_id
                 where pt.person_id = p.id and (t.name ilike ${q} or pt.useful_for ilike ${q})))`);
  }
  for (const ref of input.tags || []) {
    const tag = await requireTag(db, ref);
    where.push(`exists (select 1 from person_tags pt where pt.person_id = p.id and pt.tag_id = ${p.add(tag.id)})`);
  }
  if (input.relationship) where.push(`p.relationship = ${p.add(input.relationship)}`);
  if (input.organization) {
    const org = await resolveOrg(db, input.organization);
    where.push(`p.organization_id = ${p.add(org.id)}`);
  }
  if (input.owner) {
    const owner = await resolveUser(db, input.owner, me);
    where.push(`p.owner_id = ${p.add(owner.id)}`);
  }
  if (input.not_contacted_since) {
    const since = p.startOfDay(date(input.not_contacted_since, 'not_contacted_since'));
    where.push(`(lc.occurred_at is null or lc.occurred_at < ${since})`);
  }
  if (input.contacted_since) {
    where.push(`lc.occurred_at >= ${p.startOfDay(date(input.contacted_since, 'contacted_since'))}`);
  }
  if (input.never_contacted) where.push('lc.occurred_at is null');

  const order = {
    name: 'lower(p.name)',
    recently_contacted: 'lc.occurred_at desc nulls last, lower(p.name)',
    least_recently_contacted: 'lc.occurred_at asc nulls first, lower(p.name)',
  }[input.sort || 'name'];

  const sql =
    personSelect(p, ', count(*) over () as total') +
    (where.length ? ` where ${where.join(' and ')}` : '') +
    ` order by ${order} limit ${p.add(limit(input.limit, 25, 200))}` +
    (Number.isInteger(input.offset) && input.offset > 0 ? ` offset ${p.add(input.offset)}` : '');
  const { rows } = await db.query(sql, p.values);
  return { total: rows.length ? Number(rows[0].total) : 0, people: rows.map(personSummary) };
}

async function personDetail(db, me, id) {
  const p = new Params();
  const row = (await db.query(personSelect(p) + ` where p.id = ${p.add(id)}`, p.values)).rows[0];
  const recent = await listInteractions(db, me, { person: id, limit: 20 });
  const open = await listActions(db, me, { person: id, status: 'open' });
  return {
    ...personSummary(row),
    how_we_met: row.how_we_met,
    notes: row.notes,
    added: { by: row.added_by, on: row.added_on },
    last_updated: { by: row.updated_by, on: row.updated_on },
    recent_interactions: recent.interactions,
    open_actions: open.actions,
  };
}

export async function getPerson(db, me, input) {
  const person = await resolvePerson(db, input.person);
  return personDetail(db, me, person.id);
}

async function assertEmailFree(db, email, exceptId = null) {
  const { rows } = await db.query('select id, name from people where lower(email) = lower($1)', [email]);
  const other = rows.find((r) => r.id !== exceptId);
  if (other) throw new UserError(`${other.name} [${other.id}] already has the email ${email}.`);
}

export async function addPerson(db, me, input) {
  return db.tx(async (t) => {
    const name = required(input.name, 'name');
    const email = textOrNull(input.email);
    if (email) await assertEmailFree(t, email);
    if (!input.confirm_new) {
      const { rows } = await t.query(
        `select p.id, p.name, p.email, o.name as organization
         from people p left join organizations o on o.id = p.organization_id`,
      );
      const similar = rows.filter((r) => isSimilarPersonName(r.name, name));
      if (similar.length) {
        const list = similar
          .map((r) => `${r.name}${r.organization ? ` (${r.organization})` : ''}${r.email ? ` <${r.email}>` : ''} [${r.id}]`)
          .join('; ');
        throw new UserError(
          `Possible duplicate. Already in the CRM: ${list}. If it's the same person, use update_person. ` +
            `If it's someone else, repeat add_person with confirm_new: true.`,
        );
      }
    }
    const org = textOrNull(input.organization)
      ? await findOrCreateOrg(t, me, input.organization, input.confirm_new_organization)
      : null;
    const owner = textOrNull(input.owner) ? await resolveUser(t, input.owner, me) : null;
    const { rows } = await t.query(
      `insert into people (name, email, organization_id, role, relationship, owner_id, how_we_met, notes, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) returning id`,
      [
        name,
        email,
        org?.id ?? null,
        textOrNull(input.role),
        input.relationship || 'in_touch',
        owner?.id ?? null,
        textOrNull(input.how_we_met),
        text(input.notes) || '',
        me.id,
      ],
    );
    const id = rows[0].id;
    for (const tag of input.tags || []) {
      await tagPersonById(t, me, id, tag.tag, tag.useful_for, input.create_new_tags);
    }
    return personDetail(t, me, id);
  });
}

function appendNoteSql(p, me, note) {
  const line = p.add(`${today()} (${me.name}): ${required(note, 'append_note')}`);
  return `notes = case when notes = '' then ${line} else notes || E'\\n' || ${line} end`;
}

export async function updatePerson(db, me, input) {
  return db.tx(async (t) => {
    const person = await resolvePerson(t, input.person);
    const p = new Params();
    const sets = [];
    if (input.name !== undefined) sets.push(`name = ${p.add(required(input.name, 'name'))}`);
    if (input.email !== undefined) {
      const email = textOrNull(input.email);
      if (email) await assertEmailFree(t, email, person.id);
      sets.push(`email = ${p.add(email)}`);
    }
    if (input.organization !== undefined) {
      const org = textOrNull(input.organization)
        ? await findOrCreateOrg(t, me, input.organization, input.confirm_new_organization)
        : null;
      sets.push(`organization_id = ${p.add(org?.id ?? null)}`);
    }
    if (input.role !== undefined) sets.push(`role = ${p.add(textOrNull(input.role))}`);
    if (input.relationship !== undefined) sets.push(`relationship = ${p.add(input.relationship)}`);
    if (input.owner !== undefined) {
      const owner = textOrNull(input.owner) ? await resolveUser(t, input.owner, me) : null;
      sets.push(`owner_id = ${p.add(owner?.id ?? null)}`);
    }
    if (input.how_we_met !== undefined) sets.push(`how_we_met = ${p.add(textOrNull(input.how_we_met))}`);
    if (input.notes !== undefined && input.append_note !== undefined) {
      throw new UserError('Use either notes (replaces all notes) or append_note (adds a dated line), not both.');
    }
    if (input.notes !== undefined) sets.push(`notes = ${p.add(text(input.notes) || '')}`);
    if (input.append_note !== undefined) sets.push(appendNoteSql(p, me, input.append_note));
    if (!sets.length) throw new UserError('Nothing to update: pass at least one field to change.');
    sets.push(`updated_by = ${p.add(me.id)}`, 'updated_at = now()');
    await t.query(`update people set ${sets.join(', ')} where id = ${p.add(person.id)}`, p.values);
    return personDetail(t, me, person.id);
  });
}

// ---------------------------------------------------------------- tags

async function tagPersonById(db, me, personId, tagRef, usefulFor, createNew) {
  const tag = await findOrCreateTag(db, me, tagRef, createNew);
  const note = text(usefulFor) || '';
  // Re-tagging keeps the old note unless a new one is given.
  await db.query(
    `insert into person_tags (person_id, tag_id, useful_for, added_by) values ($1, $2, $3, $4)
     on conflict (person_id, tag_id) do update
       set useful_for = case when excluded.useful_for = '' then person_tags.useful_for else excluded.useful_for end`,
    [personId, tag.id, note, me.id],
  );
  return tag;
}

export async function tagPerson(db, me, input) {
  return db.tx(async (t) => {
    const person = await resolvePerson(t, input.person);
    const tag = await tagPersonById(t, me, person.id, input.tag, input.useful_for, input.create_new_tag);
    await t.query('update people set updated_by = $1, updated_at = now() where id = $2', [me.id, person.id]);
    const { rows } = await t.query('select useful_for from person_tags where person_id = $1 and tag_id = $2', [
      person.id,
      tag.id,
    ]);
    return { person: person.name, tag: tag.name, useful_for: rows[0].useful_for };
  });
}

export async function untagPerson(db, me, input) {
  const person = await resolvePerson(db, input.person);
  const tag = await requireTag(db, input.tag);
  const { rowCount } = await db.query('delete from person_tags where person_id = $1 and tag_id = $2', [
    person.id,
    tag.id,
  ]);
  if (!rowCount) throw new UserError(`${person.name} isn't tagged "${tag.name}".`);
  return { person: person.name, removed_tag: tag.name };
}

export async function listTags(db) {
  const { rows } = await db.query(
    `select t.name, t.description, count(pt.person_id)::int as people
     from tags t left join person_tags pt on pt.tag_id = t.id
     group by t.id order by lower(t.name)`,
  );
  return { tags: rows };
}

// Choices for the browse page's filters: every tag, the organizations people are at, and the teammates.
export async function filterOptions(db) {
  const { tags } = await listTags(db);
  const { rows: organizations } = await db.query(
    `select o.id, o.name, count(*)::int as people
     from organizations o join people p on p.organization_id = o.id
     group by o.id order by lower(o.name)`,
  );
  const { rows: teammates } = await db.query('select name, email from users order by name');
  return { tags, organizations, teammates };
}

export async function updateTag(db, me, input) {
  return db.tx(async (t) => {
    const tag = await requireTag(t, input.tag);
    const p = new Params();
    const sets = [];
    if (input.new_name !== undefined) {
      const name = required(input.new_name, 'new_name');
      const clash = await findTag(t, name);
      if (clash && clash.id !== tag.id) throw new UserError(`A tag named "${clash.name}" already exists.`);
      sets.push(`name = ${p.add(name)}`);
    }
    if (input.description !== undefined) sets.push(`description = ${p.add(text(input.description) || '')}`);
    if (!sets.length) throw new UserError('Nothing to update: pass new_name or description.');
    const { rows } = await t.query(
      `update tags set ${sets.join(', ')} where id = ${p.add(tag.id)} returning name, description`,
      p.values,
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------- organizations

export async function searchOrganizations(db, me, input = {}) {
  const p = new Params();
  const where = [];
  const query = text(input.query);
  if (query) {
    const q = p.add(`%${escapeLike(query)}%`);
    where.push(`(o.name ilike ${q} or o.notes ilike ${q} or o.website ilike ${q})`);
  }
  if (input.type) where.push(`o.type = ${p.add(input.type)}`);
  if (input.relationship) where.push(`o.relationship = ${p.add(input.relationship)}`);
  const { rows } = await db.query(
    `select o.id, o.name, o.type, o.relationship, o.website, o.notes,
       (select count(*)::int from people x where x.organization_id = o.id) as people,
       (select ${p.day('max(i.occurred_at)')}
          from interactions i
          join interaction_people ip on ip.interaction_id = i.id
          join people x on x.id = ip.person_id
          where x.organization_id = o.id) as last_contacted
     from organizations o
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by lower(o.name)
     limit ${p.add(limit(input.limit, 50, 200))}`,
    p.values,
  );
  return { organizations: rows };
}

export async function addOrganization(db, me, input) {
  const name = required(input.name, 'name');
  const existing = (await db.query('select id, name from organizations where lower(name) = lower($1)', [name])).rows[0];
  if (existing) throw new UserError(`"${existing.name}" is already in the CRM. Use update_organization to change it.`);
  if (!input.confirm_new) {
    const similar = await similarOrgs(db, name);
    if (similar.length) {
      throw new UserError(
        `Possible duplicate: ${similar.map((o) => `"${o.name}"`).join(', ')} already in the CRM. ` +
          `If "${name}" is a different organization, repeat with confirm_new: true.`,
      );
    }
  }
  const { rows } = await db.query(
    `insert into organizations (name, type, relationship, website, notes, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $6)
     returning id, name, type, relationship, website, notes`,
    [name, input.type || 'other', input.relationship || 'in_touch', textOrNull(input.website), text(input.notes) || '', me.id],
  );
  return rows[0];
}

export async function updateOrganization(db, me, input) {
  const org = await resolveOrg(db, input.organization);
  const p = new Params();
  const sets = [];
  if (input.name !== undefined) {
    const name = required(input.name, 'name');
    const clash = (await db.query('select id, name from organizations where lower(name) = lower($1)', [name])).rows[0];
    if (clash && clash.id !== org.id) throw new UserError(`"${clash.name}" is already in the CRM.`);
    sets.push(`name = ${p.add(name)}`);
  }
  if (input.type !== undefined) sets.push(`type = ${p.add(input.type)}`);
  if (input.relationship !== undefined) sets.push(`relationship = ${p.add(input.relationship)}`);
  if (input.website !== undefined) sets.push(`website = ${p.add(textOrNull(input.website))}`);
  if (input.notes !== undefined && input.append_note !== undefined) {
    throw new UserError('Use either notes (replaces all notes) or append_note (adds a dated line), not both.');
  }
  if (input.notes !== undefined) sets.push(`notes = ${p.add(text(input.notes) || '')}`);
  if (input.append_note !== undefined) sets.push(appendNoteSql(p, me, input.append_note));
  if (!sets.length) throw new UserError('Nothing to update: pass at least one field to change.');
  sets.push(`updated_by = ${p.add(me.id)}`, 'updated_at = now()');
  const { rows } = await db.query(
    `update organizations set ${sets.join(', ')} where id = ${p.add(org.id)}
     returning id, name, type, relationship, website, notes`,
    p.values,
  );
  return rows[0];
}

// ---------------------------------------------------------------- interactions

function occurredAtSql(p, value) {
  const v = text(value);
  if (!v) return 'now()';
  // A bare date means midday local time, so it lands on the right day in any time zone.
  if (DATE_RE.test(v)) return `timezone(${p.tz()}, (${p.add(date(v, 'date'))}::date + time '12:00'))`;
  if (Number.isNaN(Date.parse(v))) throw new UserError('date must look like 2026-10-15 or 2026-10-15T14:30:00-07:00.');
  return `${p.add(v)}::timestamptz`;
}

export async function logInteraction(db, me, input) {
  return db.tx(async (t) => {
    const refs = input.people || [];
    if (!refs.length) throw new UserError('people must list at least one person.');
    const people = [];
    for (const ref of refs) {
      const person = await resolvePerson(t, ref);
      if (!people.some((x) => x.id === person.id)) people.push(person);
    }
    const p = new Params();
    const { rows } = await t.query(
      `insert into interactions (type, occurred_at, summary, details, logged_by)
       values (${p.add(input.type)}, ${occurredAtSql(p, input.date)}, ${p.add(required(input.summary, 'summary'))},
               ${p.add(text(input.details) || '')}, ${p.add(me.id)})
       returning id, ${p.day('occurred_at')} as date, type, summary`,
      p.values,
    );
    for (const person of people) {
      await t.query('insert into interaction_people (interaction_id, person_id) values ($1, $2)', [rows[0].id, person.id]);
    }
    return { ...rows[0], people: people.map((x) => x.name), logged_by: me.name };
  });
}

export async function listInteractions(db, me, input = {}) {
  const p = new Params();
  const where = [];
  if (input.person) {
    const person = await resolvePerson(db, input.person);
    where.push(`exists (select 1 from interaction_people ip where ip.interaction_id = i.id and ip.person_id = ${p.add(person.id)})`);
  }
  if (input.organization) {
    const org = await resolveOrg(db, input.organization);
    where.push(`exists (select 1 from interaction_people ip join people x on x.id = ip.person_id
                        where ip.interaction_id = i.id and x.organization_id = ${p.add(org.id)})`);
  }
  if (input.type) where.push(`i.type = ${p.add(input.type)}`);
  if (input.since) where.push(`i.occurred_at >= ${p.startOfDay(date(input.since, 'since'))}`);
  if (input.until) where.push(`i.occurred_at < ${p.startOfDay(date(input.until, 'until'))} + interval '1 day'`);
  if (input.logged_by) {
    const user = await resolveUser(db, input.logged_by, me);
    where.push(`i.logged_by = ${p.add(user.id)}`);
  }
  const { rows } = await db.query(
    `select i.id, ${p.day('i.occurred_at')} as date, i.type, i.summary, i.details, u.name as logged_by,
       coalesce((
         select json_agg(json_build_object('id', x.id, 'name', x.name, 'organization', o.name) order by x.name)
         from interaction_people ip
         join people x on x.id = ip.person_id
         left join organizations o on o.id = x.organization_id
         where ip.interaction_id = i.id
       ), '[]'::json) as people
     from interactions i
     left join users u on u.id = i.logged_by
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by i.occurred_at desc
     limit ${p.add(limit(input.limit, 25, 200))}`,
    p.values,
  );
  return { interactions: rows };
}

export async function deleteInteraction(db, me, input) {
  const id = required(input.interaction_id, 'interaction_id');
  if (!UUID_RE.test(id)) throw new UserError('interaction_id must be an ID from list_interactions or get_person.');
  const { rows } = await db.query('delete from interactions where id = $1 returning summary', [id]);
  if (!rows[0]) throw new UserError(`No interaction has the ID ${id}.`);
  return { deleted: rows[0].summary };
}

// ---------------------------------------------------------------- actions

function actionSelect(p) {
  return `
    select a.id, a.title, a.type, a.status, to_char(a.due_date, 'YYYY-MM-DD') as due_date,
      x.name as person, x.email as person_email, o.name as organization,
      u.name as assigned_to, a.draft_subject, a.draft_body, a.notes,
      cb.name as created_by, ${p.day('a.created_at')} as created_on, ${p.day('a.completed_at')} as completed_on
    from actions a
    left join people x on x.id = a.person_id
    left join organizations o on o.id = x.organization_id
    left join users u on u.id = a.assigned_to
    left join users cb on cb.id = a.created_by`;
}

async function actionById(db, id) {
  const p = new Params();
  return (await db.query(actionSelect(p) + ` where a.id = ${p.add(id)}`, p.values)).rows[0];
}

export async function addAction(db, me, input) {
  const person = textOrNull(input.person) ? await resolvePerson(db, input.person) : null;
  const assignee = textOrNull(input.assigned_to) ? await resolveUser(db, input.assigned_to, me) : me;
  const { rows } = await db.query(
    `insert into actions (title, type, status, person_id, due_date, assigned_to, draft_subject, draft_body, notes, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      required(input.title, 'title'),
      input.type || 'follow_up',
      input.status || 'suggested',
      person?.id ?? null,
      textOrNull(input.due_date) ? date(input.due_date, 'due_date') : null,
      assignee.id,
      textOrNull(input.draft_subject),
      textOrNull(input.draft_body),
      text(input.notes) || '',
      me.id,
    ],
  );
  return actionById(db, rows[0].id);
}

export async function listActions(db, me, input = {}) {
  const p = new Params();
  const where = [];
  const status = input.status || 'open';
  if (status === 'open') where.push(`a.status in ('suggested', 'approved')`);
  else if (status !== 'all') where.push(`a.status = ${p.add(status)}`);
  if (input.assigned_to) {
    const user = await resolveUser(db, input.assigned_to, me);
    where.push(`a.assigned_to = ${p.add(user.id)}`);
  }
  if (input.person) {
    const person = await resolvePerson(db, input.person);
    where.push(`a.person_id = ${p.add(person.id)}`);
  }
  if (input.due_before) where.push(`a.due_date < ${p.add(date(input.due_before, 'due_before'))}::date`);
  const { rows } = await db.query(
    actionSelect(p) +
      (where.length ? ` where ${where.join(' and ')}` : '') +
      ` order by a.due_date asc nulls last, a.created_at limit ${p.add(limit(input.limit, 25, 200))}`,
    p.values,
  );
  return { actions: rows };
}

export async function updateAction(db, me, input) {
  const id = required(input.action_id, 'action_id');
  if (!UUID_RE.test(id)) throw new UserError('action_id must be an ID from list_actions.');
  if (!(await db.query('select 1 from actions where id = $1', [id])).rows[0]) {
    throw new UserError(`No action has the ID ${id}.`);
  }
  const p = new Params();
  const sets = [];
  if (input.title !== undefined) sets.push(`title = ${p.add(required(input.title, 'title'))}`);
  if (input.type !== undefined) sets.push(`type = ${p.add(input.type)}`);
  if (input.status !== undefined) {
    sets.push(`status = ${p.add(input.status)}`);
    sets.push(input.status === 'done' ? 'completed_at = coalesce(completed_at, now())' : 'completed_at = null');
  }
  if (input.due_date !== undefined) {
    sets.push(`due_date = ${p.add(textOrNull(input.due_date) ? date(input.due_date, 'due_date') : null)}`);
  }
  if (input.assigned_to !== undefined) {
    const user = textOrNull(input.assigned_to) ? await resolveUser(db, input.assigned_to, me) : null;
    sets.push(`assigned_to = ${p.add(user?.id ?? null)}`);
  }
  if (input.draft_subject !== undefined) sets.push(`draft_subject = ${p.add(textOrNull(input.draft_subject))}`);
  if (input.draft_body !== undefined) sets.push(`draft_body = ${p.add(textOrNull(input.draft_body))}`);
  if (input.notes !== undefined) sets.push(`notes = ${p.add(text(input.notes) || '')}`);
  if (!sets.length) throw new UserError('Nothing to update: pass at least one field to change.');
  sets.push('updated_at = now()');
  await db.query(`update actions set ${sets.join(', ')} where id = ${p.add(id)}`, p.values);
  return actionById(db, id);
}
