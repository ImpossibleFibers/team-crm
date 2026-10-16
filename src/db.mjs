// Database access. Production uses Netlify Database (or any Postgres given as
// DATABASE_URL); tests use PGlite (Postgres compiled to WebAssembly) through the
// same small interface:
//   query(text, params) -> { rows }
//   exec(text)          -> runs several statements (migrations)
//   tx(fn)              -> runs fn(db) inside a transaction
//   end()               -> closes the connections

import pg from 'pg';
import { getDatabase } from '@netlify/database';

// Opens connections for one request; the caller closes them with end().
// Opening per request keeps serverless functions from holding stale
// connections, and picks up Netlify's current database credentials each time.
export function openDb() {
  if (process.env.DATABASE_URL) {
    return pgDb(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
  }
  // Netlify Database: the package reads the address from Netlify's environment
  // and picks the right driver. It throws if no database is attached.
  return pgDb(getDatabase().pool);
}

export function pgDb(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async tx(fn) {
      const client = await pool.connect();
      const inner = clientDb(client);
      try {
        await client.query('begin');
        const result = await fn(inner);
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

function clientDb(client) {
  const db = {
    query: (text, params) => client.query(text, params),
    exec: (text) => client.query(text),
    // Already inside a transaction: nested calls join it.
    tx: (fn) => fn(db),
  };
  return db;
}

export function pgliteDb(lite) {
  return {
    query: (text, params) => lite.query(text, params),
    exec: (text) => lite.exec(text),
    tx: (fn) =>
      lite.transaction((t) => {
        const inner = {
          query: (text, params) => t.query(text, params),
          exec: (text) => t.exec(text),
          tx: (f) => f(inner),
        };
        return fn(inner);
      }),
    end: () => lite.close(),
  };
}
