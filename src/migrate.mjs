// Applies the migrations in netlify/database/migrations/ that haven't run yet,
// in name order. On Netlify Database, Netlify itself applies these during each
// deploy; this runner is for tests and for any other Postgres (DATABASE_URL).
//
// Each migration is a folder like 0001_init/ holding migration.sql (Netlify's
// format), or a single 0001_init.sql file. Each runs in its own transaction
// and is recorded in schema_migrations.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../netlify/database/migrations/', import.meta.url));

async function listMigrations() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => (e.isDirectory() || e.name.endsWith('.sql')) && /^\d+_/.test(e.name))
    .map((e) => ({
      name: e.name.replace(/\.sql$/, ''),
      path: MIGRATIONS_DIR + e.name + (e.isDirectory() ? '/migration.sql' : ''),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function migrate(db, { log = () => {} } = {}) {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const migration of await listMigrations()) {
    if (done.has(migration.name)) continue;
    const sql = await readFile(migration.path, 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('insert into schema_migrations (name) values ($1)', [migration.name]);
    });
    log(`Applied ${migration.name}`);
    applied.push(migration.name);
  }
  if (!applied.length) log('Database is up to date.');
  return applied;
}
