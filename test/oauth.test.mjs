// Google sign-in for the connector, end to end: the MCP SDK's own OAuth client
// discovers how to sign in, registers, sends the "browser" to Google (a fake),
// trades the code for tokens, and then calls the CRM as the signed-in teammate.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createKey, hashKey } from '../src/auth.mjs';
import { BASE, CLAUDE_CALLBACK, randomString, s256, startCrm, teammateClaims } from './helpers.mjs';

let crm;
const ana = teammateClaims('ana@example.com', 'Ana Test');
const sam = teammateClaims('sam@example.com', 'Sam Test');

before(async () => {
  crm = await startCrm();
});

const post = (path, body, headers = {}) =>
  crm.request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  });

const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const callMcp = (token, base = BASE) =>
  crm.request(`${base}/mcp`, {
    method: 'POST',
    headers: { ...mcpHeaders, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: mcpBody,
  });

// What Claude keeps for one connection, in memory.
class ClaudeProvider {
  constructor({ metadataUrl } = {}) {
    this.clientMetadataUrl = metadataUrl;
    this.saved = {};
  }
  get redirectUrl() {
    return CLAUDE_CALLBACK;
  }
  get clientMetadata() {
    return {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'claude-state';
  }
  clientInformation() {
    return this.saved.client;
  }
  saveClientInformation(info) {
    this.saved.client = info;
  }
  tokens() {
    return this.saved.tokens;
  }
  saveTokens(tokens) {
    this.saved.tokens = tokens;
  }
  redirectToAuthorization(url) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v) {
    this.saved.verifier = v;
  }
  codeVerifier() {
    return this.saved.verifier;
  }
}

async function connectAs(provider) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: crm.fetchVia }));
  return client;
}

// Runs Claude's whole sign-in: 401, discovery, registration, Google, code, tokens.
async function claudeSignsIn(provider, claims) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: crm.fetchVia });
  await assert.rejects(new Client({ name: 'test', version: '1.0.0' }).connect(transport), UnauthorizedError);
  const { response } = await crm.signInWithGoogle(provider.authorizationUrl, claims);
  assert.equal(response.status, 302);
  const back = new URL(response.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, CLAUDE_CALLBACK);
  assert.equal(back.searchParams.get('state'), 'claude-state');
  await transport.finishAuth(back.searchParams.get('code'));
  return connectAs(provider);
}

async function whoami(client) {
  const result = await client.callTool({ name: 'whoami', arguments: {} });
  return JSON.parse(result.content[0].text).you;
}

// A sign-in done by hand, for tests that need the raw code and tokens.
async function codeFor(claims, { verifier = randomString() } = {}) {
  const reg = await crm.request(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' }),
  });
  const { client_id } = await reg.json();
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
    state: 's',
    resource: `${BASE}/mcp`,
  });
  const { response } = await crm.signInWithGoogle(url, claims);
  const code = new URL(response.headers.get('location')).searchParams.get('code');
  return { client_id, code, verifier };
}

async function tokensFor(claims) {
  const { client_id, code, verifier } = await codeFor(claims);
  const res = await post('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: CLAUDE_CALLBACK });
  assert.equal(res.status, 200);
  return { client_id, ...(await res.json()) };
}

test('a 401 points Claude at the sign-in metadata', async () => {
  const res = await callMcp(null);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /^Bearer resource_metadata="https:\/\/crm\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const resource = await (await crm.request(`${BASE}${path}`)).json();
    assert.equal(resource.resource, `${BASE}/mcp`);
    assert.deepEqual(resource.authorization_servers, [BASE]);
  }
  const server = await (await crm.request(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(server.issuer, BASE);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.equal(server.registration_endpoint, `${BASE}/register`);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.ok(server.token_endpoint_auth_methods_supported.includes('none'));
});

test('Claude signs in with Google through registration, and acts as that teammate', async () => {
  const client = await claudeSignsIn(new ClaudeProvider(), ana);
  assert.deepEqual(await whoami(client), { name: 'Ana Test', email: 'ana@example.com' });
  const { rows } = await crm.db.query("select name from users where email = 'ana@example.com'");
  assert.deepEqual(rows, [{ name: 'Ana Test' }]);
  // Only hashes are stored.
  const tokens = (await crm.db.query('select token_hash from auth_tokens')).rows.map((r) => r.token_hash);
  assert.ok(tokens.every((t) => /^[0-9a-f]{64}$/.test(t)));
});

test("Claude's published identity (a client metadata document) works too", async () => {
  const url = 'https://claude.ai/oauth/test-client-metadata';
  crm.metadataDocuments.set(url, {
    client_id: url,
    client_name: 'Claude',
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const provider = new ClaudeProvider({ metadataUrl: url });
  const client = await claudeSignsIn(provider, sam);
  assert.equal((await whoami(client)).email, 'sam@example.com');
  assert.equal(provider.saved.client.client_id, url);
});

test("Claude Code's loopback return address matches whatever its port", async () => {
  const url = 'https://claude.ai/oauth/claude-code-client-metadata';
  crm.metadataDocuments.set(url, {
    client_id: url,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
  });
  const authorize = (redirectUri) => {
    const u = new URL(`${BASE}/authorize`);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: url, redirect_uri: redirectUri, code_challenge: s256(randomString()), code_challenge_method: 'S256',
    });
    return crm.request(u);
  };
  assert.equal((await authorize('http://localhost:53123/callback')).status, 302);
  assert.equal((await authorize('http://127.0.0.1:4000/callback')).status, 302);
  assert.equal((await authorize('http://localhost:53123/elsewhere')).status, 400);

  // Metadata documents are only fetched from Anthropic's hosts.
  const other = 'https://example.com/client.json';
  crm.metadataDocuments.set(other, { client_id: other, redirect_uris: [CLAUDE_CALLBACK] });
  const u = new URL(`${BASE}/authorize`);
  u.search = new URLSearchParams({ response_type: 'code', client_id: other, redirect_uri: CLAUDE_CALLBACK, code_challenge: 'x', code_challenge_method: 'S256' });
  assert.equal((await crm.request(u)).status, 400);
});

test('only verified @example.com Google accounts get through', async () => {
  const before = (await crm.db.query('select count(*)::int as n from users')).rows[0].n;
  const refused = [
    teammateClaims('someone@gmail.com', 'Someone', { hd: undefined }),
    teammateClaims('lee@example.com', 'Lee', { hd: undefined }),
    teammateClaims('lee@example.com', 'Lee', { email_verified: false }),
    teammateClaims('lee@elsewhere.com', 'Lee', { hd: 'example.com' }),
    teammateClaims('lee@example.com', 'Lee', { aud: 'some-other-app' }),
    teammateClaims('lee@example.com', 'Lee', { exp: Math.floor(Date.now() / 1000) - 60 }),
  ];
  for (const claims of refused) {
    const { client_id } = await codeFor(ana); // any registered client
    const url = new URL(`${BASE}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(randomString()), code_challenge_method: 'S256',
    });
    const { google, response } = await crm.signInWithGoogle(url, claims);
    assert.equal(google.searchParams.get('hd'), 'example.com');
    assert.equal(google.searchParams.get('prompt'), 'select_account');
    assert.ok([403, 502].includes(response.status), `${claims.email} got ${response.status}`);
    assert.equal(response.headers.get('location'), null);
  }
  assert.equal((await crm.db.query('select count(*)::int as n from users')).rows[0].n, before);
});

test("registration accepts only Claude's return addresses", async () => {
  const register = (body) =>
    crm.request(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const evil = await register({ redirect_uris: ['https://evil.example/callback'] });
  assert.equal(evil.status, 400);
  assert.equal((await evil.json()).error, 'invalid_redirect_uri');

  const ok = await register({ redirect_uris: [CLAUDE_CALLBACK, 'https://claude.com/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(ok.status, 201);
  const client = await ok.json();
  assert.match(client.client_secret, /^crmsecret_/);

  // An unregistered return address gets an error page, never a redirect.
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9999/callback', code_challenge: 'x', code_challenge_method: 'S256' });
  const res = await crm.request(url);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
});

test('authorize sends errors back to Claude: PKCE is required, and tokens are only for this server', async () => {
  const { client_id } = await codeFor(ana);
  const authorize = async (params) => {
    const url = new URL(`${BASE}/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CLAUDE_CALLBACK, state: 'abc', ...params });
    const res = await crm.request(url);
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location')).searchParams;
  };
  const noPkce = await authorize({});
  assert.equal(noPkce.get('error'), 'invalid_request');
  assert.equal(noPkce.get('state'), 'abc');
  assert.equal((await authorize({ code_challenge: 'x', code_challenge_method: 'plain' })).get('error'), 'invalid_request');
  const other = await authorize({ code_challenge: 'x', code_challenge_method: 'S256', resource: 'https://other.test/mcp' });
  assert.equal(other.get('error'), 'invalid_target');
});

test('a sign-in code works once, with the right PKCE verifier; using it twice ends that sign-in', async () => {
  const wrong = await codeFor(ana);
  const bad = await post('/token', { grant_type: 'authorization_code', code: wrong.code, code_verifier: randomString(), client_id: wrong.client_id, redirect_uri: CLAUDE_CALLBACK });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_grant');

  const { client_id, code, verifier } = await codeFor(ana);
  const form = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: CLAUDE_CALLBACK };
  const first = await post('/token', form);
  assert.equal(first.status, 200);
  const tokens = await first.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal((await callMcp(tokens.access_token)).status, 200);

  const again = await post('/token', form);
  assert.equal((await again.json()).error, 'invalid_grant');
  assert.equal((await callMcp(tokens.access_token)).status, 401);
});

test('refresh tokens rotate; an old one coming back later signs that Claude out', async () => {
  const first = await tokensFor(ana);
  const refresh = (refreshToken) => post('/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: first.client_id });

  const second = await (await refresh(first.refresh_token)).json();
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal((await callMcp(second.access_token)).status, 200);

  // The same refresh again right away is treated as Claude retrying.
  const retry = await refresh(first.refresh_token);
  assert.equal(retry.status, 200);

  // Much later it looks copied: everything from that sign-in stops working.
  await crm.db.query("update auth_tokens set used_at = now() - interval '10 minutes' where token_hash = $1", [hashKey(first.refresh_token)]);
  const replay = await refresh(first.refresh_token);
  assert.equal((await replay.json()).error, 'invalid_grant');
  assert.equal((await callMcp(second.access_token)).status, 401);
  assert.equal((await refresh(second.refresh_token)).status, 400);
});

test('expired tokens, and tokens for another server, get a 401 that says invalid_token', async () => {
  const { access_token } = await tokensFor(sam);
  const elsewhere = await callMcp(access_token, 'https://preview.crm.test');
  assert.equal(elsewhere.status, 401);
  await crm.db.query("update auth_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [hashKey(access_token)]);
  const expired = await callMcp(access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.match(expired.headers.get('www-authenticate'), /resource_metadata=/);
});

test('the token endpoint checks who is asking', async () => {
  const unknown = await post('/token', { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nobody' });
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error, 'invalid_client');

  const reg = await crm.request(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }), // defaults to client_secret_basic
  });
  const { client_id, client_secret } = await reg.json();
  const form = { grant_type: 'refresh_token', refresh_token: 'x' };
  assert.equal((await post('/token', { ...form, client_id })).status, 401);
  const basic = (secret) => ({ Authorization: `Basic ${Buffer.from(`${client_id}:${secret}`).toString('base64')}` });
  assert.equal((await post('/token', form, basic('wrong'))).status, 401);
  const right = await post('/token', form, basic(client_secret));
  assert.equal((await right.json()).error, 'invalid_grant'); // the client is fine; the token isn't
  assert.equal((await post('/token', { ...form, grant_type: 'password', client_id, client_secret })).status, 400);
});

test('secret keys keep working, and Google sign-in finds the same teammate', async () => {
  const { rows } = await crm.db.query("insert into users (email, name) values ('pat@example.com', 'Pat Example') returning id");
  const key = await createKey(crm.db, rows[0].id, 'laptop');
  assert.equal((await callMcp(key)).status, 200);
  assert.equal((await crm.request(`${BASE}/mcp`, { method: 'GET', headers: { Authorization: `Bearer ${key}` } })).status, 405);

  const client = await claudeSignsIn(new ClaudeProvider(), teammateClaims('Pat@example.com', 'Patricia E.'));
  assert.deepEqual(await whoami(client), { name: 'Pat Example', email: 'pat@example.com' });
  const count = await crm.db.query("select count(*)::int as n from users where lower(email) = 'pat@example.com'");
  assert.equal(count.rows[0].n, 1);
});

test('sign-in refuses to finish in a different browser, or once it has expired', async () => {
  const { client_id } = await codeFor(ana);
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(randomString()), code_challenge_method: 'S256' });
  const start = await crm.request(url);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const noCookie = await crm.request(`${BASE}/auth/google/callback?code=x&state=${state}`);
  assert.equal(noCookie.status, 400);
  assert.equal(noCookie.headers.get('location'), null);
  const again = await crm.request(`${BASE}/auth/google/callback?code=x&state=${state}`, { headers: { cookie: `__Host-crm_signin=${state}` } });
  assert.equal(again.status, 400); // the sign-in was used up
});

test("without Google's client ID and secret, sign-in explains what's missing", async () => {
  const { client_id } = await codeFor(ana);
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: 'x', code_challenge_method: 'S256' });
  const res = await crm.request(url, {}, { env: {} });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET need a value/);
  const secretOnly = await crm.request(url, {}, { env: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: '  ' } });
  const text = await secretOnly.text();
  assert.match(text, /GOOGLE_CLIENT_SECRET needs a value/);
  assert.doesNotMatch(text, /GOOGLE_CLIENT_ID/);

  // Without the company's email domain, nobody can sign in.
  const domain = process.env.CRM_EMAIL_DOMAIN;
  delete process.env.CRM_EMAIL_DOMAIN;
  try {
    const noDomain = await crm.request(`${BASE}/login`);
    assert.equal(noDomain.status, 503);
    assert.match(await noDomain.text(), /CRM_EMAIL_DOMAIN needs a value/);
  } finally {
    process.env.CRM_EMAIL_DOMAIN = domain;
  }
});
