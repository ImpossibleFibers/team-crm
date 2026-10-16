// Adds a teammate (if new) and a new key for them, as a migration that Netlify
// applies on the next deploy. Netlify Database only lets deploys write to the
// production database, so this is how keys get there. Only the key's hash is
// written to the file.
//
//   node scripts/add-key.mjs <email> "<name>" ["<label>"]
//
// Prints the key once. With KEY_FILE=path set, writes it to that file instead.
// Then commit and push the new migration; the key works once that deploy is live.
//
// To revoke a key later, add a migration such as:
//   update api_keys set revoked_at = now() where label = 'Old laptop';

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { hashKey, keyMigrationSql, newKey } from '../src/auth.mjs';

const [email, name, label = ''] = process.argv.slice(2);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || !name) {
  console.error('Usage: node scripts/add-key.mjs <email> "<name>" ["<label>"]');
  process.exit(1);
}

const dir = new URL('../netlify/database/migrations/', import.meta.url);
const numbers = (await readdir(dir)).map((n) => parseInt(n, 10)).filter(Number.isFinite);
const next = String(Math.max(0, ...numbers) + 1).padStart(4, '0');
const folderName = `${next}_key_${email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
const folder = new URL(`${folderName}/`, dir);

const key = newKey();
await mkdir(folder);
await writeFile(new URL('migration.sql', folder), keyMigrationSql({ email, name, label, keyHash: hashKey(key) }));

if (process.env.KEY_FILE) {
  await writeFile(process.env.KEY_FILE, key + '\n', { mode: 0o600 });
  console.log(`Wrote the key to ${process.env.KEY_FILE}.`);
} else {
  console.log(`New key for ${name}. It is shown only this once:\n\n${key}\n`);
}
console.log(`Created netlify/database/migrations/${folderName}/migration.sql. Commit and push it; the key works once that deploy is live.`);
