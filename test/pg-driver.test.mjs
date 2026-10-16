// The same connector, but through the `pg` driver that production uses,
// talking over a real Postgres network connection (PGlite behind a socket).
// This checks transactions, rollbacks and how pg returns counts and JSON.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pgDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';
import { createKey } from '../src/auth.mjs';
import { handleMcp } from '../src/server.mjs';

const PORT = 54329;
let socketServer;
let db;
let client;

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = result.content[0].text;
  if (result.isError) throw new Error(body);
  return JSON.parse(body);
}

before(async () => {
  socketServer = new PGLiteSocketServer({ db: new PGlite(), port: PORT });
  await socketServer.start();
  // PGlite serves one connection at a time, so the pool holds one.
  db = pgDb(new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/postgres`, max: 1 }));
  await migrate(db);
  const { rows } = await db.query("insert into users (email, name) values ('pat@example.com', 'Pat') returning id");
  const key = await createKey(db, rows[0].id);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://crm.test/mcp'), {
      fetch: (url, init) => handleMcp(new Request(url, init), { db }),
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
});

after(async () => {
  await client.close();
  await db.end();
  await socketServer.stop();
});

test('a failed add rolls back everything it created', async () => {
  await assert.rejects(
    call('add_person', { name: 'Ada Ray', organization: 'New Org', owner: 'nobody@example.com' }),
    /No single teammate/,
  );
  assert.equal((await call('search_organizations', { query: 'New Org' })).organizations.length, 0);
  assert.equal((await call('search_people', { query: 'Ada' })).total, 0);
});

test('people, tags, interactions and actions work through pg', async () => {
  const ada = await call('add_person', {
    name: 'Ada Ray',
    organization: 'New Org',
    tags: [{ tag: 'Robotics', useful_for: 'Haptics.' }],
    create_new_tags: true,
  });
  assert.deepEqual(ada.tags, [{ tag: 'Robotics', useful_for: 'Haptics.' }]);
  await call('log_interaction', { people: ['Ada Ray'], type: 'call', summary: 'Intro', date: '2026-10-02' });
  const found = await call('search_people', { tags: ['Robotics'] });
  assert.equal(found.total, 1);
  assert.deepEqual(found.people[0].last_contacted, { date: '2026-10-02', type: 'call', logged_by: 'Pat' });
  const action = await call('add_action', { title: 'Send paper', person: 'Ada Ray', due_date: '2026-10-20' });
  assert.equal(action.due_date, '2026-10-20');
  const orgs = await call('search_organizations', {});
  assert.deepEqual(orgs.organizations.map((o) => [o.name, o.people, o.last_contacted]), [['New Org', 1, '2026-10-02']]);
});
