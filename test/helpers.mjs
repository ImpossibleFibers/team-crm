// Shared by the sign-in and browse-page tests: an in-memory CRM behind the real
// request router, with Google (and the client metadata documents Claude
// publishes) played by a fake.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';
import { handleRequest } from '../src/app.mjs';

export const BASE = 'https://crm.test';
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const env = { GOOGLE_CLIENT_ID: 'google-client-id', GOOGLE_CLIENT_SECRET: 'google-client-secret' };
// The company's settings (src/config.mjs) are read from the environment.
process.env.CRM_EMAIL_DOMAIN = 'example.com';
process.env.CRM_NAME = 'Example CRM';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const s256 = (v) => createHash('sha256').update(v).digest('base64url');
export const randomString = () => randomBytes(32).toString('base64url');

export function teammateClaims(email, name, overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: env.GOOGLE_CLIENT_ID,
    sub: randomString(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email,
    email_verified: true,
    hd: email.split('@')[1],
    name,
    ...overrides,
  };
}

export async function startCrm() {
  const db = pgliteDb(new PGlite());
  await migrate(db);

  // Google's side: codes it handed out, each with the identity and PKCE challenge it belongs to.
  const googleCodes = new Map();
  const metadataDocuments = new Map();

  async function outside(url, init = {}) {
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body));
      const issued = googleCodes.get(form.get('code'));
      googleCodes.delete(form.get('code'));
      const ok =
        issued &&
        form.get('client_id') === env.GOOGLE_CLIENT_ID &&
        form.get('client_secret') === env.GOOGLE_CLIENT_SECRET &&
        form.get('grant_type') === 'authorization_code' &&
        s256(form.get('code_verifier') || '') === issued.challenge;
      if (!ok) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const idToken = `${b64url({ alg: 'RS256' })}.${b64url(issued.claims)}.signature`;
      return Response.json({ access_token: 'google-access', id_token: idToken, token_type: 'Bearer', expires_in: 3599 });
    }
    if (metadataDocuments.has(url)) return Response.json(metadataDocuments.get(url));
    return new Response('Not found', { status: 404 });
  }

  const request = (url, init, options = {}) =>
    handleRequest(new Request(url, init), { db, env: options.env ?? env, fetch: outside });

  // A fetch that sends requests for the CRM to the router, and everything else to the fakes.
  const fetchVia = (url, init) => {
    const href = String(url instanceof Request ? url.url : url);
    return href.startsWith(BASE) ? request(href, init) : outside(href, init);
  };

  // Plays the browser: follows /authorize or /login to Google, "signs in" there
  // as `claims`, and brings back the CRM's answer to Google's redirect.
  async function signInWithGoogle(startUrl, claims, { headers = {} } = {}) {
    const start = await request(startUrl, { headers });
    assert.equal(start.status, 302, `expected a redirect to Google, got ${start.status}`);
    const google = new URL(start.headers.get('location'));
    assert.equal(`${google.origin}${google.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
    const signInCookie = start.headers.getSetCookie().find((c) => c.startsWith('__Host-crm_signin='));
    const code = randomString();
    googleCodes.set(code, { claims, challenge: google.searchParams.get('code_challenge') });
    const back = new URL(google.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', google.searchParams.get('state'));
    const response = await request(back, { headers: { cookie: signInCookie.split(';')[0], ...headers } });
    return { google, response };
  }

  return { db, request, fetchVia, signInWithGoogle, metadataDocuments };
}

export function cookieFrom(response, name) {
  const c = response.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : null;
}
