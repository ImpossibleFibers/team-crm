# Team CRM

A CRM nobody has to open. Your team talks to Claude, and Claude reads and
writes the CRM through a connector. A read-only page shows the people list for
a quick look. Each teammate signs in with their own company Google account.

Built at [Impossible Fibers](https://impossiblefibers.com) with Claude Code.

## What your team says to Claude

- "Who do we know at Acme Labs?"
- "Log that I had coffee with Ada Ray today. She's interested in a pilot."
- "Who haven't we talked to in 90 days that's tagged Fundraising?"
- "Draft a follow-up email to Ben about the pilot." (Saved as a draft. The CRM never sends email.)

## What it keeps

- **People:** organization, role, email, how we met, notes, and the teammate who
  owns the relationship.
- **Relationship:** collaborating, want to collaborate, or in touch.
- **Tags:** topics a person is useful for (Robotics, Fundraising, …), each with
  a note on *why* they're useful for it.
- **Interactions:** meetings, calls, emails and messages. A person's "last
  contacted" date is the newest of these.
- **Actions:** follow-ups and email drafts. Claude suggests them; a teammate
  approves, finishes or dismisses them.

Every change records which teammate made it. Claude refuses likely duplicates
(similar names, same email, near-identical tags) until someone confirms.

## Set it up

[SETUP.md](SETUP.md) walks through it step by step: copy this repository, create
a Netlify project with a database, create a Google sign-in app, set four
settings, and connect Claude. You need a Google Workspace domain for your team,
and a Claude plan that allows custom connectors.

## How it's built

| Path | What it is |
|---|---|
| `src/config.mjs` | Your two settings: company email domain and CRM name |
| `netlify/functions/app.mjs` | The one serverless function, and the paths it answers |
| `src/app.mjs` | Sends each request to the right handler |
| `src/server.mjs` | The Claude connector at `/mcp`: 18 actions and the rules it gives Claude |
| `src/crm.mjs` | Everything the CRM can do |
| `src/oauth.mjs` | Google sign-in, for the connector and the browse page |
| `src/auth.mjs` | Secret keys (only a hash is stored) |
| `src/browse.mjs`, `public/app.js` | The read-only browse page and the JSON it reads (`/api/...`) |
| `netlify/database/migrations/` | Database tables. Netlify applies new ones on each deploy. |
| `scripts/add-key.mjs`, `scripts/users.mjs` | Create and revoke secret keys |
| `scripts/dev.mjs` | A local preview of the browse page with made-up people |
| `test/` | End-to-end tests against an in-memory Postgres, with Google faked |

Hosting is Netlify: static files in `public/` plus one serverless function. The
data lives in your Netlify Database (Postgres), never in this repository.

## Signing in

Only verified Google accounts on your domain (`CRM_EMAIL_DOMAIN`) get in, and a
teammate's first sign-in adds them to the team.

- **Claude** (web, desktop, phone, Claude Code) signs in by OAuth, as the MCP
  spec describes. The CRM is its own authorization server: Claude registers
  itself (or presents the client ID Anthropic publishes), the teammate signs in
  with Google, and the CRM gives Claude an access token that lasts an hour plus
  a refresh token. Each refresh token works once and is replaced. Sign-ins
  return only to Claude's callback or to the teammate's own computer.
- **The browse page** gets a 30-day session cookie (httpOnly, Secure, SameSite=Lax).
- **Secret keys** are an alternative for Claude Code or other agents (see SETUP.md).

Only SHA-256 hashes of codes, tokens, sessions and keys are stored. To sign a
teammate out everywhere, add a migration like:

```sql
update sign_in_grants set revoked_at = now()
  where user_id = (select id from users where email = 'someone@example.com');
update api_keys set revoked_at = now()
  where user_id = (select id from users where email = 'someone@example.com');
```

## Tests

```bash
npm install
npm test
```

To preview the browse page with made-up people, run `npm run dev` and open
`http://localhost:8899/dev/sign-in`.

## License

MIT. See [LICENSE](LICENSE).
