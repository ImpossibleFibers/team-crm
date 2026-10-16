// Every request the serverless function gets, sent to the right handler.
// netlify/functions/app.mjs lists the paths that reach it; everything else is
// a static file from public/.

import { openDb } from './db.mjs';
import { handleMcp } from './server.mjs';
import * as oauth from './oauth.mjs';
import * as browse from './browse.mjs';
import { json } from './http.mjs';
import { messagePage } from './pages.mjs';

// Handlers that need the database: (db, request, { env, fetch }) => Response.
const ROUTES = {
  '/authorize': oauth.authorize,
  '/token': oauth.token,
  '/register': oauth.register,
  '/auth/google/callback': oauth.googleCallback,
  '/login': oauth.login,
  '/logout': oauth.logout,
  '/': browse.page,
};

function routeFor(pathname) {
  if (ROUTES[pathname]) return ROUTES[pathname];
  if (pathname.startsWith('/api/')) return browse.api;
  if (/^\/people\/[^/]+\/?$/.test(pathname)) return browse.page;
  return null;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// What to send when something fails: JSON for programs, a page for people.
function failure(pathname, status) {
  if (['/token', '/register'].includes(pathname)) {
    return json(status, { error: status === 503 ? 'temporarily_unavailable' : 'server_error' });
  }
  const text = status === 503 ? 'The CRM database is not reachable.' : 'The CRM hit an unexpected error.';
  if (pathname.startsWith('/api/')) return json(status, { error: text });
  return messagePage(status, { title: 'Something went wrong', text: `${text} Try again in a minute.` });
}

// `db`, `env` and `fetch` are passed in by tests; in production each request
// opens and closes its own database connection.
export async function handleRequest(request, { db, env = process.env, fetch: fetchFn = fetch } = {}) {
  const { pathname } = new URL(request.url);
  if (pathname === '/mcp') return withSecurityHeaders(await handleMcp(request, { db }));
  if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') {
    return withSecurityHeaders(oauth.protectedResourceMetadata(request));
  }
  if (pathname === '/.well-known/oauth-authorization-server') {
    return withSecurityHeaders(oauth.authorizationServerMetadata(request));
  }
  const route = routeFor(pathname);
  if (!route) return withSecurityHeaders(json(404, { error: 'Not found.' }));

  let database;
  try {
    database = db || openDb();
  } catch (err) {
    console.error(err);
    return withSecurityHeaders(failure(pathname, 503));
  }
  try {
    return withSecurityHeaders(await route(database, request, { env, fetch: fetchFn }));
  } catch (err) {
    console.error(err);
    return withSecurityHeaders(failure(pathname, 500));
  } finally {
    if (!db) await database.end().catch((err) => console.error(err));
  }
}
