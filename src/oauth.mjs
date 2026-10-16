// Google sign-in, for Claude's connector and for the browse page.
//
// For the connector, the CRM is its own OAuth 2.1 authorization server, as the
// MCP authorization spec (2025-11-25) describes:
//   1. Claude calls /mcp without a token and gets a 401 pointing at
//      /.well-known/oauth-protected-resource/mcp, which names this site as the
//      authorization server. /.well-known/oauth-authorization-server lists its endpoints.
//   2. Claude identifies itself: it registers at /register, or uses the URL of a
//      client metadata document Anthropic hosts as its client_id.
//   3. /authorize checks Claude's request and sends the teammate to Google.
//   4. Google sends them back to /auth/google/callback. Only verified accounts
//      on your Google Workspace domain (CRM_EMAIL_DOMAIN) get through. The email
//      is matched to the users table, and a row is added on someone's first sign-in.
//   5. The callback hands Claude a one-time code, which Claude trades at /token,
//      with its PKCE verifier, for an access token that lasts an hour and a
//      refresh token. Each refresh token works once and comes back replaced.
//
// The browse page uses the same Google sign-in (/login) and gets a session cookie.
// Codes, tokens and sessions are random strings; only their SHA-256 hashes are stored.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashKey } from './auth.mjs';
import { settings } from './config.mjs';
import { clearCookie, json, methodNotAllowed, readCookie, redirect, setCookie } from './http.mjs';
import { messagePage } from './pages.mjs';

const SCOPE = 'crm';

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 90 * 24 * 60 * 60;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;
const SIGN_IN_SECONDS = 10 * 60;
// A refresh token used again within this many seconds is taken as Claude
// retrying, not as a copied token, and still works.
const REFRESH_RETRY_SECONDS = 60;

export const SESSION_COOKIE = '__Host-crm_session';
const SIGN_IN_COOKIE = '__Host-crm_signin';

// The only places sign-in codes are sent: Claude's callback for its web,
// desktop and phone apps, and loopback addresses on the teammate's own
// computer (Claude Code), whose port changes from session to session.
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
// Client metadata documents are fetched only from Anthropic's hosts.
const METADATA_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

// Prefixes make each kind of secret recognizable, and keep them apart from API keys ("crm_").
const PREFIX = { code: 'crmcode_', access: 'crmat_', refresh: 'crmrt_', session: 'crmsess_' };

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const s256 = (value) => createHash('sha256').update(value).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

export function siteUrls(request) {
  const { origin } = new URL(request.url);
  return {
    origin,
    resource: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
    googleCallback: `${origin}/auth/google/callback`,
  };
}

function googleClient(env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// Says which settings are missing, never their values.
function notSetUp(env, cookies) {
  const missing = ['CRM_EMAIL_DOMAIN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) =>
    k === 'CRM_EMAIL_DOMAIN' ? !settings().domain : !env[k]?.trim(),
  );
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
  const text = `${list} ${missing.length > 1 ? 'need' : 'needs'} a value in Netlify's environment variables, for Production and the Functions scope. Then deploy again.`;
  return problem(503, "Google sign-in isn't set up yet", text, null, cookies);
}

// ---------------------------------------------------------------- discovery

export function protectedResourceMetadata(request) {
  const { origin, resource } = siteUrls(request);
  return json(200, {
    resource,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: settings().name,
  });
}

export function authorizationServerMetadata(request) {
  const { origin } = siteUrls(request);
  return json(200, {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    client_id_metadata_document_supported: true,
  });
}

// The 401 that starts sign-in: it tells Claude where to read how to sign in.
export function unauthorized(request, tokenGiven) {
  const description = tokenGiven ? 'The key or sign-in is not valid or has expired.' : 'Sign in to use the CRM.';
  const params = [`resource_metadata="${siteUrls(request).resourceMetadata}"`, `scope="${SCOPE}"`];
  if (tokenGiven) params.unshift('error="invalid_token"', `error_description="${description}"`);
  return json(
    401,
    { error: tokenGiven ? 'invalid_token' : 'unauthorized', error_description: description },
    { 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
  );
}

// ---------------------------------------------------------------- checking tokens and sessions

const bearerToken = (header) => /^Bearer\s+(\S+)\s*$/i.exec(header || '')?.[1] || null;

async function userForToken(db, kind, token, resource = null) {
  const { rows } = await db.query(
    `select u.id, u.email, u.name
     from auth_tokens t
     join sign_in_grants g on g.id = t.grant_id
     join users u on u.id = g.user_id
     where t.token_hash = $1 and t.kind = $2 and t.expires_at > now() and g.revoked_at is null
       and ($3::text is null or g.resource = $3::text)`,
    [hashKey(token), kind, resource],
  );
  return rows[0] || null;
}

// Returns { id, email, name } for a valid access token issued for `resource`, else null.
export async function userForAccessToken(db, header, resource) {
  const token = bearerToken(header);
  return token?.startsWith(PREFIX.access) ? userForToken(db, 'access', token, resource) : null;
}

export async function userForSession(db, request) {
  const token = readCookie(request, SESSION_COOKIE);
  return token?.startsWith(PREFIX.session) ? userForToken(db, 'session', token) : null;
}

async function issue(db, grantId, kind, seconds, { redirectUri = null, codeChallenge = null } = {}) {
  const token = PREFIX[kind] + random();
  await db.query(
    `insert into auth_tokens (token_hash, grant_id, kind, redirect_uri, code_challenge, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [hashKey(token), grantId, kind, redirectUri, codeChallenge, seconds],
  );
  return token;
}

// ---------------------------------------------------------------- clients

const isLoopback = (u) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

function allowedRedirect(uri) {
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  const u = parseUrl(uri);
  return Boolean(u) && isLoopback(u) && !u.hash;
}

function redirectMatches(registered, requested) {
  const want = parseUrl(requested);
  if (!want) return false;
  return registered.some((r) => {
    if (r === requested) return true;
    const have = parseUrl(r);
    // Loopback addresses match whatever the port (RFC 8252, section 7.3).
    return Boolean(have) && isLoopback(have) && isLoopback(want) && have.hostname === want.hostname &&
      have.pathname === want.pathname && have.search === want.search;
  });
}

function isMetadataDocumentUrl(clientId) {
  const u = parseUrl(clientId);
  if (!u || u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || u.pathname === '/') return false;
  return METADATA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

async function fetchClientMetadata(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = await res.text();
  if (body.length > 20000) throw new Error(`${url} is too large to be a client metadata document`);
  const doc = JSON.parse(body);
  if (doc?.client_id !== url || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((r) => typeof r === 'string')) {
    throw new Error(`${url} is not a valid client metadata document`);
  }
  return { name: String(doc.client_name || '').slice(0, 200), redirectUris: doc.redirect_uris };
}

// A registered client, or one identified by a metadata document URL (fetched,
// then cached for a day).
async function clientFor(db, clientId, fetchFn) {
  if (!clientId) return null;
  const { rows } = await db.query(
    `select *, metadata_fetched_at > now() - interval '1 day' as fresh from oauth_clients where client_id = $1`,
    [clientId],
  );
  const known = rows[0] || null;
  if (!clientId.startsWith('https://')) return known;
  if (!isMetadataDocumentUrl(clientId)) {
    console.warn(`Refused a client metadata document outside Anthropic's hosts: ${clientId}`);
    return null;
  }
  if (known?.fresh) return known;
  let doc;
  try {
    doc = await fetchClientMetadata(clientId, fetchFn);
  } catch (err) {
    console.error(err);
    return known;
  }
  const saved = await db.query(
    `insert into oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, metadata_fetched_at)
     values ($1, $2, $3::jsonb, 'none', now())
     on conflict (client_id) do update
       set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, metadata_fetched_at = now()
     returning *`,
    [clientId, doc.name, JSON.stringify(doc.redirectUris)],
  );
  return saved.rows[0];
}

const registrationError = (error, description) => json(400, { error, error_description: description });

// Dynamic client registration (RFC 7591).
export async function register(db, request) {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let body;
  try {
    body = await request.json();
  } catch {
    return registrationError('invalid_client_metadata', 'Send the client metadata as JSON.');
  }
  const redirectUris = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every((u) => typeof u === 'string')) {
    return registrationError('invalid_redirect_uri', 'redirect_uris must list at least one URL.');
  }
  const refused = redirectUris.find((u) => !allowedRedirect(u));
  if (refused) {
    return registrationError('invalid_redirect_uri', `This CRM signs in Claude only, so it won't send sign-ins to ${refused}.`);
  }
  const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!AUTH_METHODS.includes(method)) {
    return registrationError('invalid_client_metadata', `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(', ')}.`);
  }
  if (![].concat(body.grant_types ?? []).every((g) => ['authorization_code', 'refresh_token'].includes(g))) {
    return registrationError('invalid_client_metadata', 'Only the authorization_code and refresh_token grant types are supported.');
  }
  if (![].concat(body.response_types ?? []).every((r) => r === 'code')) {
    return registrationError('invalid_client_metadata', 'Only the code response type is supported.');
  }

  const clientId = 'crmclient_' + random(16);
  const secret = method === 'none' ? null : 'crmsecret_' + random();
  const name = String(body.client_name || '').slice(0, 200);
  await db.query(
    `insert into oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, secret_hash)
     values ($1, $2, $3::jsonb, $4, $5)`,
    [clientId, name, JSON.stringify(redirectUris), method, secret && hashKey(secret)],
  );
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

// ---------------------------------------------------------------- signing in with Google

const problem = (status, title, text, action, cookies) => messagePage(status, { title, text, action }, { cookies });

// Tokens are only for this server's connector. Claude names it in `resource`;
// the bare site address is accepted too.
function isOurResource(asked, request) {
  const u = parseUrl(asked);
  if (!u || u.hash || u.search) return false;
  const { origin, resource } = siteUrls(request);
  const given = (u.origin + u.pathname).replace(/\/$/, '');
  return given === resource || given === origin;
}

async function startGoogleSignIn(db, request, env, s) {
  const google = googleClient(env);
  const { domain } = settings();
  if (!google || !domain) return notSetUp(env);
  const state = random();
  const verifier = random();
  await db.query('delete from sign_ins where expires_at < now()');
  await db.query(
    `insert into sign_ins (state_hash, purpose, google_verifier, retry_path, client_id, redirect_uri, client_state,
                           code_challenge, resource, next_path, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))`,
    [
      hashKey(state),
      s.purpose,
      verifier,
      s.retryPath,
      s.clientId ?? null,
      s.redirectUri ?? null,
      s.clientState ?? null,
      s.codeChallenge ?? null,
      s.resource ?? null,
      s.nextPath ?? null,
      SIGN_IN_SECONDS,
    ],
  );
  const to = new URL(GOOGLE_AUTHORIZE);
  to.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: siteUrls(request).googleCallback,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
    // Google shows only accounts on your domain; the callback still checks.
    hd: domain,
    prompt: 'select_account',
  });
  // The same browser has to come back: the callback checks this cookie against `state`.
  return redirect(to, { cookies: [setCookie(SIGN_IN_COOKIE, state, SIGN_IN_SECONDS)] });
}

// Claude's authorization request.
export async function authorize(db, request, { env, fetch: fetchFn }) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const url = new URL(request.url);
  const q = url.searchParams;
  const client = await clientFor(db, q.get('client_id'), fetchFn);
  if (!client) {
    return problem(400, "This sign-in link isn't from Claude", 'In Claude, remove the CRM connector and add it again.');
  }
  const redirectUri = q.get('redirect_uri') || '';
  if (!allowedRedirect(redirectUri) || !redirectMatches(client.redirect_uris, redirectUri)) {
    return problem(400, 'This sign-in link has the wrong return address', 'In Claude, remove the CRM connector and add it again.');
  }
  const state = q.get('state');
  const refuse = (error, description) => {
    const back = new URL(redirectUri);
    back.searchParams.set('error', error);
    back.searchParams.set('error_description', description);
    if (state) back.searchParams.set('state', state);
    return redirect(back);
  };
  if (q.get('response_type') !== 'code') return refuse('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = q.get('code_challenge');
  if (!challenge || q.get('code_challenge_method') !== 'S256') {
    return refuse('invalid_request', 'A PKCE code_challenge with code_challenge_method=S256 is required.');
  }
  const { resource } = siteUrls(request);
  if (q.has('resource') && !isOurResource(q.get('resource'), request)) {
    return refuse('invalid_target', `Tokens here are only for ${resource}.`);
  }
  return startGoogleSignIn(db, request, env, {
    purpose: 'connector',
    retryPath: url.pathname + url.search,
    clientId: client.client_id,
    redirectUri,
    clientState: state,
    codeChallenge: challenge,
    resource,
  });
}

async function googleIdentity(google, code, verifier, redirectUri, fetchFn) {
  const res = await fetchFn(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== 'string') {
    throw new Error(`Google's token endpoint answered ${res.status} ${body.error || ''}`.trim());
  }
  // The ID token came straight from Google over HTTPS, so its signature needn't
  // be checked (OpenID Connect Core 1.0, section 3.1.3.7). Its claims still are.
  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] || '', 'base64url').toString('utf8'));
  const issuerOk = ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss);
  if (!issuerOk || claims.aud !== google.clientId || !(claims.exp * 1000 > Date.now())) {
    throw new Error('Google returned an ID token that is not for this app.');
  }
  return claims;
}

// The email of a verified Google Workspace account on your domain, else null.
function teamEmail(claims, domain) {
  const email = String(claims.email || '').toLowerCase();
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return verified && claims.hd === domain && email.endsWith(`@${domain}`) ? email : null;
}

async function teammate(db, email, name) {
  await db.query('insert into users (email, name) values ($1, $2) on conflict ((lower(email))) do nothing', [
    email,
    String(name || '').trim() || email.split('@')[0],
  ]);
  return (await db.query('select id, email, name from users where lower(email) = lower($1)', [email])).rows[0];
}

async function createGrant(db, userId, kind, clientId = null, resource = null) {
  const { rows } = await db.query(
    'insert into sign_in_grants (user_id, kind, client_id, resource) values ($1, $2, $3, $4) returning id',
    [userId, kind, clientId, resource],
  );
  return rows[0].id;
}

export async function googleCallback(db, request, { env, fetch: fetchFn }) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const q = new URL(request.url).searchParams;
  const state = q.get('state') || '';
  const done = [clearCookie(SIGN_IN_COOKIE)];
  const { rows } = await db.query('delete from sign_ins where state_hash = $1 returning *, expires_at > now() as live', [
    hashKey(state),
  ]);
  const signIn = rows[0];
  if (!signIn?.live) {
    return problem(400, 'That sign-in has expired', 'Start again from Claude or from the CRM page.', { href: '/', label: 'Open the CRM' }, done);
  }
  const retry = { href: signIn.retry_path, label: 'Try again' };
  if (readCookie(request, SIGN_IN_COOKIE) !== state) {
    return problem(400, 'Sign-in has to finish in the browser it started in', 'Start again here.', retry, done);
  }
  if (q.has('error') || !q.get('code')) {
    return problem(400, 'Sign-in was cancelled', 'Nothing was changed.', retry, done);
  }
  const google = googleClient(env);
  const { domain } = settings();
  if (!google || !domain) return notSetUp(env, done);
  let claims;
  try {
    claims = await googleIdentity(google, q.get('code'), signIn.google_verifier, siteUrls(request).googleCallback, fetchFn);
  } catch (err) {
    console.error(err);
    return problem(502, "Google sign-in didn't finish", 'Try again in a moment.', retry, done);
  }
  const email = teamEmail(claims, domain);
  if (!email) {
    const who = claims.email ? `${claims.email} isn't` : "That isn't";
    return problem(403, `Use your @${domain} account`, `${who} an @${domain} Google account.`,
      { href: signIn.retry_path, label: 'Choose another account' }, done);
  }
  const user = await teammate(db, email, claims.name);

  if (signIn.purpose === 'connector') {
    const grant = await createGrant(db, user.id, 'connector', signIn.client_id, signIn.resource);
    const code = await issue(db, grant, 'code', CODE_SECONDS, {
      redirectUri: signIn.redirect_uri,
      codeChallenge: signIn.code_challenge,
    });
    const back = new URL(signIn.redirect_uri);
    back.searchParams.set('code', code);
    if (signIn.client_state) back.searchParams.set('state', signIn.client_state);
    return redirect(back, { cookies: done });
  }
  const grant = await createGrant(db, user.id, 'browse');
  const session = await issue(db, grant, 'session', SESSION_SECONDS);
  return redirect(signIn.next_path || '/', {
    status: 303,
    cookies: [...done, setCookie(SESSION_COOKIE, session, SESSION_SECONDS)],
  });
}

// ---------------------------------------------------------------- the token endpoint

const tokenError = (status, error, description, headers) =>
  json(status, { error, error_description: description }, headers);

async function readParams(request) {
  if ((request.headers.get('content-type') || '').includes('application/json')) {
    const body = await request.json().catch(() => null);
    return new URLSearchParams(Object.entries(body && typeof body === 'object' ? body : {}).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(await request.text());
}

// The client from client_id, checking its secret if it has one (sent with
// HTTP Basic or in the form). Public clients have no secret and rely on PKCE.
async function authenticateClient(db, request, params) {
  let clientId = params.get('client_id');
  let secret = params.get('client_secret');
  const basic = /^Basic\s+(\S+)\s*$/i.exec(request.headers.get('authorization') || '');
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    try {
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    } catch {
      return null;
    }
  }
  if (!clientId) return null;
  const client = (await db.query('select * from oauth_clients where client_id = $1', [clientId])).rows[0];
  if (!client) return null;
  if (client.secret_hash && !(secret && safeEqual(hashKey(secret), client.secret_hash))) return null;
  return client;
}

async function tokenResponse(db, grantId) {
  const accessToken = await issue(db, grantId, 'access', ACCESS_TOKEN_SECONDS);
  const refreshToken = await issue(db, grantId, 'refresh', REFRESH_TOKEN_SECONDS);
  await db.query('update sign_in_grants set last_used_at = now() where id = $1', [grantId]);
  return json(200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
}

async function exchangeCode(db, request, client, params) {
  const codeHash = hashKey(params.get('code') || '');
  const { rows } = await db.query(
    `update auth_tokens set used_at = now()
     where token_hash = $1 and kind = 'code' and used_at is null
     returning grant_id, redirect_uri, code_challenge, expires_at > now() as live`,
    [codeHash],
  );
  const code = rows[0];
  if (!code) {
    // A code presented twice may have been copied: end whatever its first use got.
    await db.query(
      `update sign_in_grants g set revoked_at = now()
       from auth_tokens t
       where t.token_hash = $1 and t.kind = 'code' and g.id = t.grant_id and g.revoked_at is null`,
      [codeHash],
    );
    return tokenError(400, 'invalid_grant', 'This sign-in code is not valid or was already used. Sign in again.');
  }
  const grant = (await db.query('select * from sign_in_grants where id = $1', [code.grant_id])).rows[0];
  if (!code.live || grant.revoked_at || grant.client_id !== client.client_id) {
    return tokenError(400, 'invalid_grant', 'This sign-in code has expired or was issued to another client.');
  }
  if (params.get('redirect_uri') !== code.redirect_uri) {
    return tokenError(400, 'invalid_grant', 'redirect_uri does not match the sign-in request.');
  }
  const verifier = params.get('code_verifier') || '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== code.code_challenge) {
    return tokenError(400, 'invalid_grant', 'code_verifier does not match the code_challenge.');
  }
  if (params.has('resource') && !isOurResource(params.get('resource'), request)) {
    return tokenError(400, 'invalid_target', `Tokens here are only for ${siteUrls(request).resource}.`);
  }
  return tokenResponse(db, grant.id);
}

async function refresh(db, request, client, params) {
  const hash = hashKey(params.get('refresh_token') || '');
  const { rows } = await db.query(
    `select t.grant_id, t.used_at is not null as used, t.used_at > now() - make_interval(secs => $2) as just_used,
            t.expires_at > now() as live, g.client_id, g.revoked_at is not null as revoked
     from auth_tokens t join sign_in_grants g on g.id = t.grant_id
     where t.token_hash = $1 and t.kind = 'refresh'`,
    [hash, REFRESH_RETRY_SECONDS],
  );
  const token = rows[0];
  if (!token || !token.live || token.revoked || token.client_id !== client.client_id) {
    return tokenError(400, 'invalid_grant', 'This refresh token is not valid. Sign in again.');
  }
  if (token.used && !token.just_used) {
    // A replaced refresh token coming back later suggests it was copied: sign that Claude out.
    await db.query('update sign_in_grants set revoked_at = now() where id = $1', [token.grant_id]);
    return tokenError(400, 'invalid_grant', 'This refresh token was already used. Sign in again.');
  }
  if (params.has('resource') && !isOurResource(params.get('resource'), request)) {
    return tokenError(400, 'invalid_target', `Tokens here are only for ${siteUrls(request).resource}.`);
  }
  await db.query('update auth_tokens set used_at = now() where token_hash = $1 and used_at is null', [hash]);
  return tokenResponse(db, token.grant_id);
}

export async function token(db, request) {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const params = await readParams(request);
  const client = await authenticateClient(db, request, params);
  if (!client) {
    // invalid_client tells Claude to register again.
    return tokenError(401, 'invalid_client', 'Unknown client, or the wrong client secret.', { 'WWW-Authenticate': 'Basic realm="crm"' });
  }
  await db.query("delete from auth_tokens where expires_at < now() - interval '1 day'");
  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') return exchangeCode(db, request, client, params);
  if (grantType === 'refresh_token') return refresh(db, request, client, params);
  return tokenError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

// ---------------------------------------------------------------- the browse page's sign-in

// Only paths on this site, so a link can't send someone elsewhere after sign-in.
// Spaces and control characters are refused too: browsers drop tabs from URLs,
// so "/<tab>/evil.example" would become "//evil.example".
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])[\x21-\x7e]*$/.test(next) && next.length < 2000 ? next : '/';
}

export async function login(db, request, { env }) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const next = safeNext(new URL(request.url).searchParams.get('next'));
  if (await userForSession(db, request)) return redirect(next);
  return startGoogleSignIn(db, request, env, {
    purpose: 'browse',
    nextPath: next,
    retryPath: `/login?next=${encodeURIComponent(next)}`,
  });
}

export async function logout(db, request) {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const session = readCookie(request, SESSION_COOKIE);
  if (session) {
    await db.query(
      `update sign_in_grants g set revoked_at = now()
       from auth_tokens t
       where t.token_hash = $1 and t.kind = 'session' and g.id = t.grant_id`,
      [hashKey(session)],
    );
  }
  return redirect('/', { status: 303, cookies: [clearCookie(SESSION_COOKIE)] });
}
