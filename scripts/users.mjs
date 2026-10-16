// Manage teammates and their keys directly, for a Postgres you can write to
// (DATABASE_URL). On Netlify Database the command-line credentials are
// read-only, so only `list` works there; add keys with scripts/add-key.mjs.
// `npx netlify database status --branch production --show-credentials` prints
// the read-only address.
//
//   node scripts/users.mjs list
//   node scripts/users.mjs add <email> <name>
//   node scripts/users.mjs key <email> [label]     prints a new key once
//   node scripts/users.mjs revoke <key-id>

import { openDb } from '../src/db.mjs';
import { createKey } from '../src/auth.mjs';

const [command, ...args] = process.argv.slice(2);
const db = openDb();

async function userByEmail(email) {
  const user = (await db.query('select id, name, email from users where lower(email) = lower($1)', [email])).rows[0];
  if (!user) throw new Error(`No teammate with the email ${email}. Add them first: users.mjs add <email> <name>`);
  return user;
}

try {
  if (command === 'list') {
    const { rows } = await db.query(
      `select u.name, u.email, k.id as key_id, k.label, k.created_at, k.last_used_at, k.revoked_at
       from users u left join api_keys k on k.user_id = u.id
       order by u.name, k.created_at`,
    );
    console.table(rows);
  } else if (command === 'add') {
    const [email, ...name] = args;
    if (!email || !name.length) throw new Error('Usage: users.mjs add <email> <name>');
    const { rows } = await db.query('insert into users (email, name) values ($1, $2) returning id, name, email', [
      email,
      name.join(' '),
    ]);
    console.log(`Added ${rows[0].name} <${rows[0].email}>`);
  } else if (command === 'key') {
    const [email, ...label] = args;
    if (!email) throw new Error('Usage: users.mjs key <email> [label]');
    const user = await userByEmail(email);
    const key = await createKey(db, user.id, label.join(' '));
    console.log(`New key for ${user.name}. It is shown only this once:\n\n${key}\n`);
  } else if (command === 'revoke') {
    const [id] = args;
    const { rowCount } = await db.query('update api_keys set revoked_at = now() where id = $1 and revoked_at is null', [id]);
    console.log(rowCount ? 'Key revoked.' : 'No active key with that ID.');
  } else {
    console.log('Commands: list | add <email> <name> | key <email> [label] | revoke <key-id>');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
