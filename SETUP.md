# Setting up your team's CRM

About an hour, once. You need:

- A **Google Workspace** domain for your team (for example `yourcompany.com`),
  and an account there that can create a Google Cloud project.
- A **GitHub** account and a **Netlify** account.
- **Claude** on a plan that allows custom connectors. The Free plan allows one.

Throughout, `<site>` means your Netlify address, such as
`yourcompany-crm.netlify.app`.

## 1. Copy this repository

On GitHub, click **Use this template → Create a new repository**. Make it
**private**. It will hold your code, never your contacts; those live in the database.

## 2. Create the Netlify project and its database

1. In Netlify: **Add new project → Import an existing project → GitHub**, and
   pick your new repository. The build settings come from `netlify.toml`, so
   leave them as they are, and click **Deploy**.
2. Note your address under **Project overview**. That's `<site>`. You can rename it
   under **Project configuration → General → Change project name**.
3. Open the project's **Database** page and add a **Netlify Database**. Then go
   to **Deploys → Trigger deploy → Deploy project**, so the tables get created.

## 3. Create the Google sign-in app

Sign in to <https://console.cloud.google.com> with your work account.

1. **Create a project:** <https://console.cloud.google.com/projectcreate>. Name it
   after the CRM, and under **Organization** and **Location** choose your
   company's domain. That's what allows the next step to be "Internal".
2. **Set up the sign-in screen:** open **APIs & Services → OAuth consent
   screen** (also called Google Auth Platform) and click **Get started**.
   - App name: your CRM's name. User support email: yours. **Next.**
   - Audience: **Internal**. This limits sign-in to your company's accounts. **Next.**
   - Contact information: your email. **Next.**
   - Tick **I agree to the Google API Services: User Data Policy**, then
     **Continue** and **Create**.
3. **Create the client:** in the same section click **Clients → Create client**.
   - Application type: **Web application**. Name: anything, such as `CRM`.
   - Under **Authorized redirect URIs**, add exactly
     `https://<site>/auth/google/callback`.
   - Click **Create**. Copy the **Client ID** and **Client secret** now. Google
     may not show the secret again; **Download JSON** saves both.

## 4. Enter the four settings in Netlify

In Netlify: **Project configuration → Environment variables → Add a variable
→ Add a single variable**, four times:

| Key | Value |
|---|---|
| `CRM_EMAIL_DOMAIN` | Your Workspace domain, such as `yourcompany.com` |
| `CRM_NAME` | What to call the CRM, such as `Acme CRM`. Optional; default `Team CRM` |
| `GOOGLE_CLIENT_ID` | The client ID from step 3 |
| `GOOGLE_CLIENT_SECRET` | The client secret from step 3. Tick **Contains secret values** |

With **Contains secret values** ticked, Netlify shows a separate box for each
deploy context, and they start empty. Paste the value into the **Production**
box. Netlify never shows a secret again, even to you.

Then deploy again so the CRM picks up the settings: **Deploys → Trigger deploy
→ Deploy project**.

## 5. Check it

- Open `https://<site>/`. You should see a **Sign in with Google** button.
  Sign in with your work account and you'll see the (empty) People list.
- If a page says **"Google sign-in isn't set up yet"**, it names the setting
  that's missing. Fix it and deploy again.
- Check the database tables were created. Install the Netlify command-line
  tool (`npm install -g netlify-cli`), run `netlify link` in your copy of the
  repository, then:

  ```bash
  netlify database status --branch production
  ```

  `0001_init` and `0002_sign_in` should be listed under **Applied**. If they're
  still pending, run `netlify deploy --prod` from your copy of the repository.
  It builds there, includes the migrations, and Netlify applies them. Do the
  same check whenever you add a migration later.

## 6. Connect Claude

- **On your own plan (Free, Pro or Max):** in Claude, go to **Customize →
  Connectors → Add custom connector**. Name it, and for the URL enter
  `https://<site>/mcp`. Leave the OAuth fields empty. Click **Add**, then
  **Connect**, and sign in with Google.
- **On a Team or Enterprise plan:** an Owner adds it once under
  **Organization settings → Connectors → Add → Custom**, with the same URL.
  Each teammate then clicks **Connect** under **Customize → Connectors**.

Connectors added on the web also appear in the Claude desktop and phone apps.
Start a chat and ask: "Run whoami on the CRM." It should answer with your name.

Send teammates the same URL. Each signs in with their own work account, and
their changes are recorded under their name.

## Optional: a secret key instead of signing in

For Claude Code, or another agent that takes a URL plus a header, you can issue
a key. On Netlify Database only deploys can write, so a key ships as a migration
that holds only its hash:

```bash
KEY_FILE=key.txt node scripts/add-key.mjs agent@yourcompany.com "Agent name" "label"
git add netlify/database/migrations && git commit -m "Add a key" && git push
```

The key is written to `key.txt` (delete it once it's pasted where it's needed)
and works once that deploy has applied the migration (see step 5). Use it as
the header `Authorization: Bearer <key>` with the URL `https://<site>/mcp`, or
in Claude Code:

```bash
claude mcp add --transport http crm https://<site>/mcp --header "Authorization: Bearer <key>"
```

To revoke a key, add a migration that sets `revoked_at` (see the header of
`scripts/add-key.mjs`).

## Optional: time zone

Dates are shown in `America/Los_Angeles` unless you set `CRM_TIMEZONE`, for
example `Europe/London`.
