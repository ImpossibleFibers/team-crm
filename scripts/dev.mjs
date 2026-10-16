// A local preview of the browse page, with made-up people in an in-memory
// database. Nothing here touches the live CRM, and Google isn't involved:
// /dev/sign-in gives this browser a session as a made-up teammate.
//
//   npm run dev        then open http://localhost:8899/dev/sign-in

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';
import { handleRequest } from '../src/app.mjs';
import { hashKey } from '../src/auth.mjs';
import { SESSION_COOKIE } from '../src/oauth.mjs';
import { config } from '../netlify/functions/app.mjs';
import * as crm from '../src/crm.mjs';

const PORT = Number(process.env.PORT) || 8899;
const PUBLIC = new URL('../public/', import.meta.url);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };

const db = pgliteDb(new PGlite());
await migrate(db);

async function seed() {
  const addUser = async (email, name) =>
    (await db.query('insert into users (email, name) values ($1, $2) returning id, email, name', [email, name])).rows[0];
  const me = await addUser('pat@example.test', 'Pat Example');
  await addUser('lee@example.test', 'Lee Example');
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const people = [
    ['Avery Quill', 'Northwind Labs', 'Materials lead', 'collaborating', 'pat@example.test', [['Robotics', 'Runs a soft-robotics lab that tests e-skin fibers.'], ['Spinning', 'Has wet-spinning lines we could borrow.']], 12],
    ['Blake Fenn', 'Northwind Labs', 'Engineer', 'in_touch', 'lee@example.test', [['Robotics', 'Builds tactile grippers for warehouse arms.']], 45],
    ['Casey Moor', 'Granite Fund', 'Partner', 'want_to_collaborate', 'pat@example.test', [['Funding', 'Invests in early materials companies; asked for our deck.']], 130],
    ['Devon Hale', 'Tidewater University', 'Professor', 'collaborating', 'lee@example.test', [['Protein fibers', 'Studies spider-silk proteins and their folding.'], ['Spinning', 'Knows microfluidic spinning well.']], 3],
    ['Emery Stroud', 'Tidewater University', 'Postdoc', 'in_touch', null, [['Protein fibers', 'Expresses silk proteins in yeast.']], null],
    ['Finley Rowe', 'Copperline Textiles', 'Head of R&D', 'want_to_collaborate', 'pat@example.test', [['Textiles', 'Can run pilot knits on industrial machines.']], 70],
    ['Gray Ashby', null, 'Consultant', 'in_touch', null, [], null],
    ['Harper Vale', 'Granite Fund', 'Associate', 'in_touch', 'lee@example.test', [['Funding', 'Screens seed-stage deals for the fund.']], 220],
  ];
  for (const [name, organization, role, relationship, owner, tags, lastDays] of people) {
    await crm.addPerson(db, me, {
      name, organization, role, relationship, owner,
      email: `${name.split(' ')[0].toLowerCase()}@example.test`,
      how_we_met: organization ? `Met at a ${organization} visit.` : null,
      tags: tags.map(([tag, useful_for]) => ({ tag, useful_for })),
      create_new_tags: true, confirm_new: true, confirm_new_organization: true,
    });
    if (lastDays != null) {
      await crm.logInteraction(db, me, { people: [name], type: 'meeting', summary: 'Intro meeting', details: 'Talked about fibers and next steps.', date: day(lastDays + 30) });
      await crm.logInteraction(db, me, { people: [name], type: 'email_sent', summary: 'Sent our one-pager', date: day(lastDays) });
    }
  }
  await crm.logInteraction(db, me, { people: ['Avery Quill', 'Blake Fenn'], type: 'call', summary: 'Gripper skin test results', date: day(2) });
  await crm.updatePerson(db, me, { person: 'Avery Quill', append_note: 'Wants samples of the 20 µm fiber.' });
  await crm.addAction(db, me, {
    title: 'Send Avery fiber samples', type: 'email', person: 'Avery Quill', due_date: day(-5),
    draft_subject: 'Fiber samples', draft_body: 'Hi Avery,\n\nWe can send three samples next week. Which diameters are most useful?\n\nPat',
  });
  await crm.addAction(db, me, { title: 'Book a lab visit', person: 'Avery Quill', status: 'approved', assigned_to: 'lee@example.test' });
  return me;
}

const me = await seed();

const isAppPath = (pathname) =>
  config.path.some((p) => (p.endsWith('/*') ? pathname.startsWith(p.slice(0, -1)) : pathname === p));

async function devSession() {
  const grant = await db.query("insert into sign_in_grants (user_id, kind) values ($1, 'browse') returning id", [me.id]);
  const token = 'crmsess_dev_' + Math.random().toString(36).slice(2);
  await db.query(
    "insert into auth_tokens (token_hash, grant_id, kind, expires_at) values ($1, $2, 'session', now() + interval '1 day')",
    [hashKey(token), grant.rows[0].id],
  );
  return token;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let response;
    if (url.pathname === '/dev/sign-in') {
      response = new Response(null, {
        status: 303,
        headers: { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=${await devSession()}; Path=/; HttpOnly; Secure; SameSite=Lax` },
      });
    } else if (isAppPath(url.pathname)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      response = await handleRequest(new Request(url, { method: req.method, headers: req.headers, body }), { db, env: {} });
    } else {
      const file = new URL(`.${url.pathname}`, PUBLIC);
      const contents = file.href.startsWith(PUBLIC.href) ? await readFile(file).catch(() => null) : null;
      response = contents
        ? new Response(contents, { headers: { 'Content-Type': TYPES[extname(url.pathname)] || 'application/octet-stream' } })
        : new Response('Not found', { status: 404 });
    }
    for (const [k, v] of response.headers) if (k !== 'set-cookie') res.setHeader(k, v);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.writeHead(response.status);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end('Error');
  }
}).listen(PORT, () => console.log(`Browse page preview: http://localhost:${PORT}/dev/sign-in`));
