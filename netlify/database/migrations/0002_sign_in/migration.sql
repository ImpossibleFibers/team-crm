-- Google sign-in, for Claude's connector and for the browse page.
-- Only SHA-256 hashes of codes, tokens and sessions are stored.

-- Apps allowed to ask a teammate to sign in. Claude either registers itself here
-- (dynamic client registration) or identifies itself by the URL of a metadata
-- document Anthropic hosts, which is cached here.
create table oauth_clients (
  client_id text primary key,
  client_name text not null default '',
  redirect_uris jsonb not null,
  -- 'none' for public clients (they prove themselves with PKCE alone); otherwise
  -- the client also has a secret, of which only the hash is kept.
  token_endpoint_auth_method text not null default 'none',
  secret_hash text,
  -- For clients identified by a metadata document URL: when it was last fetched.
  metadata_fetched_at timestamptz,
  created_at timestamptz not null default now()
);

-- A sign-in in progress: from sending someone to Google until Google sends them back.
create table sign_ins (
  state_hash text primary key,
  purpose text not null check (purpose in ('connector', 'browse')),
  google_verifier text not null,
  -- Where "Try again" starts over.
  retry_path text not null,
  -- Connector sign-ins: the request Claude made.
  client_id text,
  redirect_uri text,
  client_state text,
  code_challenge text,
  resource text,
  -- Browse sign-ins: the page to return to.
  next_path text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- One row per completed Google sign-in: a connected Claude, or a browser.
-- Setting revoked_at signs it out and ends every token issued for it.
create table sign_in_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null check (kind in ('connector', 'browse')),
  client_id text references oauth_clients (client_id) on delete cascade,
  -- The connector address the tokens are for, e.g. https://<site>/mcp.
  resource text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index sign_in_grants_user_idx on sign_in_grants (user_id);

-- Authorization codes, access tokens and refresh tokens for Claude, and browse-page sessions.
create table auth_tokens (
  token_hash text primary key,
  grant_id uuid not null references sign_in_grants (id) on delete cascade,
  kind text not null check (kind in ('code', 'access', 'refresh', 'session')),
  -- Authorization codes only: what the token request must match.
  redirect_uri text,
  code_challenge text,
  expires_at timestamptz not null,
  -- Codes and refresh tokens work once; this is when that happened.
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_grant_idx on auth_tokens (grant_id);
create index auth_tokens_expires_idx on auth_tokens (expires_at);
