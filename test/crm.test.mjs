// End-to-end tests: a real MCP client talks to the connector, which runs
// against an in-memory Postgres (PGlite) with the real migrations applied.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pgliteDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';
import { createKey, hashKey, keyMigrationSql, newKey } from '../src/auth.mjs';
import { handleMcp } from '../src/server.mjs';

let db;
let pat;
let lee;

const endpoint = new URL('http://crm.test/mcp');
const fetchVia = (url, init) => handleMcp(new Request(url, init), { db });

async function connect(key) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchVia,
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = result.content[0].text;
  if (result.isError) throw new Error(body);
  return JSON.parse(body);
}

before(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db);
  const addUser = async (email, name) =>
    (await db.query('insert into users (email, name) values ($1, $2) returning id', [email, name])).rows[0].id;
  pat = await connect(await createKey(db, await addUser('pat@example.com', 'Pat')));
  lee = await connect(await createKey(db, await addUser('lee@example.com', 'Lee')));
});

test('migrations are recorded and not re-applied', async () => {
  assert.deepEqual(await migrate(db), []);
});

test('requests without a valid key are refused', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetchVia(endpoint, { method: 'POST', headers, body })).status, 401);
  const wrong = { ...headers, Authorization: 'Bearer crm_not-a-real-key' };
  assert.equal((await fetchVia(endpoint, { method: 'POST', headers: wrong, body })).status, 401);
  assert.equal((await fetchVia(endpoint, { method: 'GET' })).status, 401);
});

test('lists every tool and sends the CRM rules to Claude', async () => {
  const { tools } = await pat.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'add_action', 'add_organization', 'add_person', 'delete_interaction', 'get_person', 'list_actions',
    'list_interactions', 'list_tags', 'log_interaction', 'search_organizations', 'search_people', 'tag_person',
    'untag_person', 'update_action', 'update_organization', 'update_person', 'update_tag', 'whoami',
  ]);
  assert.match(pat.getInstructions(), /Search before adding/);
});

test('whoami names the signed-in teammate', async () => {
  const me = await call(lee, 'whoami');
  assert.equal(me.you.name, 'Lee');
  assert.equal(me.team.length, 2);
  assert.match(me.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('adding a person creates the organization and tags, with notes on why', async () => {
  await assert.rejects(
    call(pat, 'add_person', { name: 'Ben Ito', tags: [{ tag: 'Robotics' }] }),
    /no tag named "Robotics" yet/,
  );
  const ben = await call(pat, 'add_person', {
    name: 'Ben Ito',
    email: 'ben@acmelabs.example',
    organization: 'Acme Labs',
    role: 'Founder',
    how_we_met: 'Intro call about CRMs',
    tags: [
      { tag: 'Robotics', useful_for: 'Builds tactile grippers.' },
      { tag: 'Fiber Drawing', useful_for: 'Knows fiber drawing rigs.' },
    ],
    create_new_tags: true,
  });
  assert.equal(ben.organization, 'Acme Labs');
  assert.equal(ben.relationship, 'in_touch');
  assert.deepEqual(ben.tags, [
    { tag: 'Fiber Drawing', useful_for: 'Knows fiber drawing rigs.' },
    { tag: 'Robotics', useful_for: 'Builds tactile grippers.' },
  ]);
  assert.equal(ben.last_contacted, null);
  assert.deepEqual(ben.added.by, 'Pat');
});

test('likely duplicate people, organizations and tags are refused until confirmed', async () => {
  await assert.rejects(call(lee, 'add_person', { name: 'Benjamin Ito' }), /Possible duplicate.*Ben Ito/);
  await assert.rejects(call(lee, 'add_person', { name: 'B. Ito', email: 'BEN@acmelabs.example' }), /already has the email/);
  await assert.rejects(call(lee, 'add_person', { name: 'Ada Ray', organization: 'AcmeLabs Inc.' }), /look similar: "Acme Labs"/);
  await assert.rejects(call(lee, 'add_organization', { name: 'acme labs' }), /already in the CRM/);
  await assert.rejects(call(lee, 'tag_person', { person: 'Ben Ito', tag: 'Robots' }), /look similar: "Robotics"/);

  const other = await call(lee, 'add_person', { name: 'Benjamin Ito', confirm_new: true });
  assert.equal(other.name, 'Benjamin Ito');
});

test('people can be found by email, exact name or ID, and ambiguous names are refused', async () => {
  await call(pat, 'add_person', { name: 'Sam Lee', organization: 'Fiber Works', confirm_new_organization: true });
  await call(pat, 'add_person', { name: 'Sam Lee', organization: 'DARPA', confirm_new: true });
  await assert.rejects(call(pat, 'get_person', { person: 'sam lee' }), /More than one person is named "sam lee"/);
  const byEmail = await call(pat, 'get_person', { person: 'ben@acmelabs.example' });
  const byId = await call(pat, 'get_person', { person: byEmail.id });
  assert.equal(byId.name, 'Ben Ito');
  await assert.rejects(call(pat, 'get_person', { person: 'Nobody Here' }), /No person matches/);
});

test('re-tagging updates the note; untagging removes it', async () => {
  const tagged = await call(lee, 'tag_person', { person: 'Ben Ito', tag: 'robotics', useful_for: 'Ran a gripper startup.' });
  assert.deepEqual(tagged, { person: 'Ben Ito', tag: 'Robotics', useful_for: 'Ran a gripper startup.' });
  const kept = await call(lee, 'tag_person', { person: 'Ben Ito', tag: 'Robotics' });
  assert.equal(kept.useful_for, 'Ran a gripper startup.');

  await call(lee, 'tag_person', { person: 'Benjamin Ito', tag: 'Fiber Drawing' });
  await call(lee, 'untag_person', { person: 'Benjamin Ito', tag: 'Fiber Drawing' });
  const { tags } = await call(lee, 'list_tags');
  assert.deepEqual(tags.map((t) => [t.name, t.people]), [['Fiber Drawing', 1], ['Robotics', 1]]);
});

test('logging interactions sets last contacted, and search filters on it', async () => {
  const logged = await call(lee, 'log_interaction', {
    people: ['Ben Ito', 'ben@acmelabs.example'],
    type: 'email_sent',
    summary: 'Sent the CRM notes',
    date: '2026-10-01',
  });
  assert.equal(logged.date, '2026-10-01');
  assert.deepEqual(logged.people, ['Ben Ito']);
  await call(pat, 'log_interaction', { people: ['Ben Ito'], type: 'meeting', summary: 'Coffee', date: '2026-09-15' });

  const ben = await call(pat, 'get_person', { person: 'Ben Ito' });
  assert.deepEqual(ben.last_contacted, { date: '2026-10-01', type: 'email_sent', logged_by: 'Lee' });
  assert.deepEqual(ben.recent_interactions.map((i) => i.summary), ['Sent the CRM notes', 'Coffee']);

  const stale = await call(pat, 'search_people', { not_contacted_since: '2026-09-20' });
  assert.ok(!stale.people.some((p) => p.name === 'Ben Ito'));
  assert.ok(stale.people.some((p) => p.name === 'Benjamin Ito'));
  const recent = await call(pat, 'search_people', { contacted_since: '2026-09-20' });
  assert.deepEqual(recent.people.map((p) => p.name), ['Ben Ito']);
  const never = await call(pat, 'search_people', { never_contacted: true });
  assert.equal(never.total, 3);
});

test('search combines tags, relationship, organization, owner and text', async () => {
  await call(pat, 'add_person', {
    name: 'Rae Kim',
    organization: 'Acme Labs',
    relationship: 'collaborating',
    owner: 'Lee',
    tags: [{ tag: 'Robotics', useful_for: 'Soft actuators.' }],
  });
  const both = await call(pat, 'search_people', { tags: ['Robotics', 'Fiber Drawing'] });
  assert.deepEqual(both.people.map((p) => p.name), ['Ben Ito']);
  const collab = await call(pat, 'search_people', { tags: ['robotics'], relationship: 'collaborating' });
  assert.deepEqual(collab.people.map((p) => [p.name, p.owner]), [['Rae Kim', 'Lee']]);
  const atSpec = await call(pat, 'search_people', { organization: 'acme labs', sort: 'least_recently_contacted' });
  assert.deepEqual(atSpec.people.map((p) => p.name), ['Rae Kim', 'Ben Ito']);
  const owned = await call(lee, 'search_people', { owner: 'me' });
  assert.deepEqual(owned.people.map((p) => p.name), ['Rae Kim']);
  const text = await call(pat, 'search_people', { query: 'actuators' });
  assert.deepEqual(text.people.map((p) => p.name), ['Rae Kim']);
  await assert.rejects(call(pat, 'search_people', { tags: ['Robots'] }), /No tag is named "Robots". Similar: "Robotics"/);
});

test('updates record who made them; notes append with date and name', async () => {
  await call(pat, 'update_person', { person: 'Ben Ito', append_note: 'Recommended Twenty.' });
  const updated = await call(lee, 'update_person', {
    person: 'Ben Ito',
    relationship: 'want_to_collaborate',
    append_note: 'Interested in a pilot.',
    role: '',
  });
  const lines = updated.notes.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2} \(Pat\): Recommended Twenty\.$/);
  assert.match(lines[1], /\(Lee\): Interested in a pilot\.$/);
  assert.equal(updated.relationship, 'want_to_collaborate');
  assert.equal(updated.role, null);
  assert.equal(updated.last_updated.by, 'Lee');
  await assert.rejects(call(lee, 'update_person', { person: 'Ben Ito' }), /Nothing to update/);
  await assert.rejects(call(lee, 'update_person', { person: 'Ben Ito', email: 'nobody@nowhere' , owner: 'Zed' }), /No single teammate/);
});

test('organizations show people counts and last contact', async () => {
  const org = await call(pat, 'update_organization', { organization: 'Acme Labs', type: 'partner', append_note: 'Met via Ben.' });
  assert.equal(org.type, 'partner');
  const { organizations } = await call(pat, 'search_organizations', { type: 'partner' });
  assert.deepEqual(organizations.map((o) => [o.name, o.people, o.last_contacted]), [['Acme Labs', 2, '2026-10-01']]);
  const nsf = await call(pat, 'add_organization', { name: 'NSF', type: 'funder' });
  assert.equal(nsf.relationship, 'in_touch');
});

test('interactions can be listed by organization, type, dates and teammate, and deleted', async () => {
  const atSpec = await call(pat, 'list_interactions', { organization: 'Acme Labs' });
  assert.deepEqual(atSpec.interactions.map((i) => i.summary), ['Sent the CRM notes', 'Coffee']);
  const emails = await call(pat, 'list_interactions', { type: 'email_sent', logged_by: 'lee@example.com' });
  assert.equal(emails.interactions.length, 1);
  const sept = await call(pat, 'list_interactions', { since: '2026-09-01', until: '2026-09-15' });
  assert.deepEqual(sept.interactions.map((i) => i.summary), ['Coffee']);

  const oops = await call(pat, 'log_interaction', { people: ['Rae Kim'], type: 'call', summary: 'Wrong person' });
  assert.deepEqual(await call(pat, 'delete_interaction', { interaction_id: oops.id }), { deleted: 'Wrong person' });
  const rae = await call(pat, 'get_person', { person: 'Rae Kim' });
  assert.equal(rae.last_contacted, null);
});

test('actions: suggest an email draft, approve it, finish it', async () => {
  const action = await call(pat, 'add_action', {
    title: 'Follow up with Ben about the pilot',
    type: 'email',
    person: 'Ben Ito',
    due_date: '2026-10-29',
    draft_subject: 'Pilot',
    draft_body: 'Hi Ben, ...',
  });
  assert.equal(action.status, 'suggested');
  assert.equal(action.assigned_to, 'Pat');
  assert.equal(action.due_date, '2026-10-29');

  const mine = await call(pat, 'list_actions', { assigned_to: 'me' });
  assert.deepEqual(mine.actions.map((a) => a.title), ['Follow up with Ben about the pilot']);
  assert.equal((await call(lee, 'list_actions', { assigned_to: 'me' })).actions.length, 0);

  await call(pat, 'update_action', { action_id: action.id, status: 'approved' });
  const done = await call(pat, 'update_action', { action_id: action.id, status: 'done' });
  assert.match(done.completed_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await call(pat, 'list_actions', {})).actions.length, 0);
  assert.equal((await call(pat, 'list_actions', { status: 'done' })).actions.length, 1);
  const ben = await call(pat, 'get_person', { person: 'Ben Ito' });
  assert.equal(ben.open_actions.length, 0);
});

test('tags can be renamed, but not onto an existing name', async () => {
  await assert.rejects(call(pat, 'update_tag', { tag: 'Robotics', new_name: 'fiber drawing' }), /already exists/);
  const renamed = await call(pat, 'update_tag', { tag: 'Robotics', new_name: 'Robotics & Haptics', description: 'Touch, grippers, e-skin' });
  assert.equal(renamed.name, 'Robotics & Haptics');
  const ben = await call(pat, 'get_person', { person: 'Ben Ito' });
  assert.ok(ben.tags.some((t) => t.tag === 'Robotics & Haptics'));
});

test('a key shipped as a migration works, and re-running adds a key without a duplicate teammate', async () => {
  const key1 = newKey();
  const key2 = newKey();
  await db.exec(keyMigrationSql({ email: 'Cris@Example.com', name: "Cris O'Neil", label: 'laptop', keyHash: hashKey(key1) }));
  await db.exec(keyMigrationSql({ email: 'cris@example.com', name: 'Cris', label: 'phone', keyHash: hashKey(key2) }));
  for (const key of [key1, key2]) {
    const cris = await connect(key);
    assert.equal((await call(cris, 'whoami')).you.name, "Cris O'Neil");
  }
  const { rows } = await db.query("select count(*)::int as n from users where lower(email) = 'cris@example.com'");
  assert.equal(rows[0].n, 1);
});

test('bad input comes back as a message Claude can act on', async () => {
  await assert.rejects(call(pat, 'log_interaction', { people: [], type: 'call', summary: 'x' }), /at least one person/);
  await assert.rejects(call(pat, 'add_action', { title: 'x', due_date: 'next Tuesday' }), /must be a date like/);
  await assert.rejects(call(pat, 'update_action', { action_id: 'nope' }), /must be an ID/);
  // A literal % in a search matches only a literal %, not everything.
  assert.equal((await call(pat, 'search_people', { query: '%' })).total, 0);
});
