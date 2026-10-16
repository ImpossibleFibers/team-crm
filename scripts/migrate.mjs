// Runs on every Netlify build (npm run build) and can be run by hand.
//
// With Netlify Database, Netlify applies netlify/database/migrations/ itself
// during each deploy, so there's nothing to do here. With any other Postgres
// (DATABASE_URL), this applies them, on production builds only, so a preview
// of a branch can never change the live tables.

import { openDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';

if (!process.env.DATABASE_URL) {
  console.log('No DATABASE_URL: Netlify Database applies the migrations during deploy.');
  process.exit(0);
}
const context = process.env.CONTEXT; // Netlify sets this: production, deploy-preview, branch-deploy
if (context && context !== 'production') {
  console.log(`Skipping database migrations on a ${context} build.`);
  process.exit(0);
}

const db = openDb();
try {
  await migrate(db, { log: (line) => console.log(line) });
} finally {
  await db.end();
}
