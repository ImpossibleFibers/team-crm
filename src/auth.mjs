// Secret keys. A key is "crm_" + 32 random bytes; only its SHA-256 hash is stored.

import { createHash, randomBytes } from 'node:crypto';

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function newKey() {
  return 'crm_' + randomBytes(32).toString('base64url');
}

export async function createKey(db, userId, label = '') {
  const key = newKey();
  await db.query('insert into api_keys (user_id, label, key_hash) values ($1, $2, $3)', [
    userId,
    label,
    hashKey(key),
  ]);
  return key;
}

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

// SQL that adds a teammate (if new) and one key for them. On Netlify Database
// only deploys can write to production, so new keys ship as migrations.
// Only the key's hash goes into the file.
export function keyMigrationSql({ email, name, label = '', keyHash }) {
  return `-- Adds a teammate (if new) and a key for them. Only the key's SHA-256 hash is stored.
insert into users (email, name) values (${sqlText(email)}, ${sqlText(name)})
  on conflict ((lower(email))) do nothing;
insert into api_keys (user_id, label, key_hash)
  select id, ${sqlText(label)}, ${sqlText(keyHash)} from users where lower(email) = lower(${sqlText(email)});
`;
}

// Returns { id, email, name } for a valid "Authorization: Bearer <key>" header, else null.
export async function userForAuthHeader(db, header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  if (!match) return null;
  const { rows } = await db.query(
    `update api_keys k set last_used_at = now()
     from users u
     where k.key_hash = $1 and k.revoked_at is null and u.id = k.user_id
     returning u.id, u.email, u.name`,
    [hashKey(match[1])],
  );
  return rows[0] || null;
}
