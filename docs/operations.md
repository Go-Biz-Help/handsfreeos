# Running HandsFreeOS

This guide covers everything about HandsFreeOS that lives outside the code: the database, hosting, the web app, the phone carrier, email, connected mailboxes, your laptop setup, and going live. Each section gives the steps in order, with what you should see after each one. Secrets never go in this repository: they live in Fly.io secrets, GitHub repository secrets, Vercel environment variables and your password manager, and nowhere else.

If you are setting up HandsFreeOS for the first time, start with the checklist in "Going live, and when something goes wrong". It tells you which parts of the other sections to do, and in what order.

Some sections are split into named parts. The rest of this guide refers to them by these names:

- Fly Part 1 to Fly Part 10: "Hosting: the API and the worker on Fly.io".
- Twilio Step 1 to Twilio Step 4: "The phone carrier: Twilio".
- Postmark Part A to Postmark Part J: "Email: Postmark".
- Stage 0 to Stage 9 (the go-live checklist) and Check 1 to Check 9 (the end-to-end check): "Going live, and when something goes wrong".

A plain "step 5" means step 5 of the list you are reading, or of the part named next to it.

## Contents

- [Before you start](#before-you-start)
- [The database: Supabase (hosted)](#the-database-supabase-hosted)
- [Hosting: the API and the worker on Fly.io](#hosting-the-api-and-the-worker-on-flyio)
- [The web app on Vercel](#the-web-app-on-vercel)
- [The phone carrier: Twilio](#the-phone-carrier-twilio)
- [Email: Postmark](#email-postmark)
- [Connected mailboxes: Outlook and Gmail](#connected-mailboxes-outlook-and-gmail)
- [Local development](#local-development)
- [Going live, and when something goes wrong](#going-live-and-when-something-goes-wrong)

## Before you start

### Accounts

Go Biz Help (or the company that owns HandsFreeOS, if it has its own) holds and pays for every account below. Client businesses never get accounts of their own: their phone lines live in Twilio subaccounts under your master account, and their email goes through your one Postmark server. Prices were checked in September 2026 and will change.

| Account                                                             | What HandsFreeOS uses it for                                                      | Rough cost                                                                                                                                                                                                                         | More in                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Supabase, organization `Go Biz Help` (already exists)               | The database, sign-in, file storage and live updates                              | Pro plan from $25 a month for the whole organization, plus about $10 a month for this project's Micro compute. Point-in-time recovery is optional, about $105 a month more.                                                        | "The database: Supabase (hosted)"           |
| Fly.io (a new organization, with a card)                            | Runs the API and the worker                                                       | About $8 a month in `dfw` with one worker machine (about $6.40 in `iad`), or about $12 with two                                                                                                                                    | "Hosting: the API and the worker on Fly.io" |
| Vercel (a Pro team)                                                 | Runs the web app at `https://app.handsfreeos.com`                                 | $20 a month, including one seat that can deploy and $20 of usage credit. 14-day trial.                                                                                                                                             | "The web app on Vercel"                     |
| Twilio (one master account, upgraded to paid)                       | Phone numbers, texts and calls for every client                                   | A starting balance of about $50. Then $1.15 a month per local number, $2.15 per toll-free number, texts and minutes, and carrier registration fees for local numbers. All client subaccounts draw on the master account's balance. | "The phone carrier: Twilio"                 |
| Postmark (Platform plan recommended)                                | Business email, customers' replies, platform mail and sign-in email               | $18 a month for 10,000 emails on Platform ($16.50 on Pro, which allows only 10 domains)                                                                                                                                            | "Email: Postmark"                           |
| Microsoft Entra tenant, plus the Microsoft AI Cloud Partner Program | The Outlook app registration and publisher verification                           | Free (an Azure sign-up may ask for a card to confirm who you are)                                                                                                                                                                  | "Connected mailboxes: Outlook and Gmail"    |
| Google Cloud                                                        | The Gmail client and the Google sign-in client                                    | Free from Google. The CASA security assessment is paid to an authorized lab: for example $675 to $855 one time for the lowest level, or $4,500 to $5,400 a year on a lab's yearly plan.                                            | "Connected mailboxes: Outlook and Gmail"    |
| GitHub, account `gobizhelp` (already exists)                        | The repository `gobizhelp/handsfreeos`, CI and the Deploy workflow                | No new cost                                                                                                                                                                                                                        | "Hosting: the API and the worker on Fly.io" |
| Cloudflare (already holds the DNS for `handsfreeos.com`)            | DNS records, and optionally a tunnel for laptop testing                           | DNS: no new cost. Zero Trust Free plan for the tunnel.                                                                                                                                                                             | Several sections                            |
| A website host for `handsfreeos.com`                                | Public home page, `/privacy` and `/terms` pages. Google and Microsoft check them. | Depends on the host                                                                                                                                                                                                                | "Connected mailboxes: Outlook and Gmail"    |

### Tools on your Mac

Run each check in Terminal and install only what is missing.

1. Check Homebrew.

   ```bash
   brew --version
   ```

   You should see a line that starts with `Homebrew`. If you see `command not found`, install Homebrew from `https://brew.sh` and run the lines it prints under **Next steps**.

2. Install the Fly.io command line (`fly`, also called `flyctl`).

   ```bash
   brew install flyctl
   ```

3. Install the GitHub command line (`gh`).

   ```bash
   brew install gh
   ```

4. Install the Supabase command line. You need version `2.117.0` (the version CI uses) or later.

   ```bash
   brew install supabase/tap/supabase
   ```

5. Check that each one answers.

   ```bash
   fly version && gh --version && supabase --version
   ```

   You should see a version number for each of the three.

6. Sign in to Fly.io. Your browser opens; confirm there.

   ```bash
   fly auth login
   ```

   You should see Terminal say that you are signed in.

7. Sign in to GitHub.

   ```bash
   gh auth login
   ```

   You should see `gh` say that you are logged in as `gobizhelp`.

`openssl`, `curl`, `dig`, `pbcopy`, `nano` and TextEdit come with macOS. Local development also needs Node 22, pnpm 12, Colima and Docker, and optionally `cloudflared`. "Local development" lists those, with their install commands.

### Your password manager folder

Make one folder in your password manager named `HandsFreeOS`. Every secret in this guide goes there first, then only into the one place named below. Never commit a secret, never save it in a file inside the repository folder, and never paste it into a chat, an email or a support ticket. CI runs gitleaks over the whole git history and checks that the web build has no Supabase secret key, but do not count on either to catch every key or password.

| Entry                                                                      | Holds                                                                                                                   | Where the value goes                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase postgres password                                                 | The hosted database password for the `postgres` user                                                                    | Only the Supabase CLI, typed in when it asks. No app.                                                                                                                                                                           |
| hfos_api database password                                                 | The `hfos_api` password and the finished `DATABASE_URL` string                                                          | Fly.io secret `DATABASE_URL` on `handsfreeos-api`                                                                                                                                                                               |
| hfos_worker database password                                              | The `hfos_worker` password and the finished `DATABASE_URL_WORKER` string                                                | Fly.io secret `DATABASE_URL_WORKER` on `handsfreeos-worker`                                                                                                                                                                     |
| Supabase publishable key                                                   | The `sb_publishable_...` key. Not secret.                                                                               | Vercel `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                                                                                                                                                                                   |
| Supabase secret key (worker)                                               | The `sb_secret_...` key named `hfos_worker`                                                                             | Fly.io secret `SUPABASE_SECRET_KEY` on `handsfreeos-worker` only                                                                                                                                                                |
| Worker encryption key (current)                                            | `WORKER_ENCRYPTION_KEY`. Old keys stay as separate entries labeled "previous, retired <date>" and are never deleted.    | Fly.io secrets `WORKER_ENCRYPTION_KEY` and, after a rotation, `WORKER_ENCRYPTION_KEYS_PREVIOUS` on `handsfreeos-worker`                                                                                                         |
| Twilio master account                                                      | The master **Account SID** and **Auth Token**                                                                           | Fly.io secrets `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` on `handsfreeos-worker`                                                                                                                                             |
| Twilio primary customer profile SID                                        | The approved Trust Hub profile (`BU...`)                                                                                | Fly.io secret `TWILIO_PRIMARY_PROFILE_SID` on `handsfreeos-worker`                                                                                                                                                              |
| Postmark login                                                             | Your Postmark password                                                                                                  | Nowhere else                                                                                                                                                                                                                    |
| Postmark server API token                                                  | The production server's API token                                                                                       | Fly.io secrets `POSTMARK_SERVER_TOKEN` and, inside it, `SMTP_URL` on `handsfreeos-worker`. Supabase's SMTP settings only if you do not use an SMTP token.                                                                       |
| Postmark account API token                                                 | The account-level API token                                                                                             | Fly.io secret `POSTMARK_ACCOUNT_TOKEN` on `handsfreeos-worker`                                                                                                                                                                  |
| Postmark webhook password                                                  | A value you make with `openssl rand -hex 24`                                                                            | Fly.io secret `POSTMARK_WEBHOOK_PASSWORD` on `handsfreeos-worker`, and inside both Postmark webhook addresses                                                                                                                   |
| Postmark SMTP token                                                        | An Access Key and Secret Key                                                                                            | Supabase's SMTP settings only                                                                                                                                                                                                   |
| Worker SMTP_URL                                                            | The finished `smtp://...` string built from the server API token                                                        | Fly.io secret `SMTP_URL` on `handsfreeos-worker`                                                                                                                                                                                |
| Microsoft Entra app                                                        | The **Application (client) ID**, the client secret **Value**, its expiry date, and your Partner Global Account (PGA) ID | Fly.io secrets `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET` on `handsfreeos-worker`. The PGA ID goes only into the Entra app's **Branding & properties** page, under **Add Partner ID to verify publisher**. |
| Google Gmail client                                                        | The Gmail OAuth client's **Client ID** and **Client secret**                                                            | Fly.io secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` on `handsfreeos-worker`                                                                                                                                |
| Google sign-in client                                                      | The separate OAuth client for Sign in with Google                                                                       | Supabase's Google provider only                                                                                                                                                                                                 |
| Google local sign-in client                                                | The OAuth client for Sign in with Google on the local stack (see "Local development")                                   | The repository-root `.env` on your Mac only, as `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`. Git ignores that file.                                                                    |
| Dev tunnel token, Postmark dev server token, Postmark dev webhook password | Laptop testing only (see "Local development")                                                                           | On your Mac only: the tunnel token in `~/.cloudflared/handsfreeos-dev.token`, the two Postmark dev values in `apps/worker/.env`. The dev webhook password also goes inside the dev server's webhook address in Postmark.        |

Two values do not follow the pattern. The Fly.io deploy token (`FLY_API_TOKEN`) lives only in GitHub, not in your password manager: if it is lost, you make a new one. The file `.env.hosted` at the repository root already holds the two database passwords, the two finished connection strings and the publishable key. It is gitignored and exists only on your Mac. Never commit, attach or paste it anywhere.

The API refuses to start if it holds any variable whose name contains `SECRET`, `SERVICE_ROLE`, `SIGNING_KEY` or `ENCRYPTION_KEY`, or starts with `TWILIO_`, `POSTMARK_`, `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_`. So every provider secret goes on `handsfreeos-worker`, never on `handsfreeos-api`, and never in Vercel or GitHub.

## The database: Supabase (hosted)

Supabase runs the HandsFreeOS database, sign-in (Supabase Auth), file storage and live updates. There is one hosted project:

- Name: `HandsFreeOS`, in the Supabase organization `Go Biz Help`.
- Project ref: `ybupfghakoszfcxhyrby`. Region: `us-east-1`. Postgres 17.
- Dashboard: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby`
- Project URL: `https://ybupfghakoszfcxhyrby.supabase.co`
- Session pooler host: `aws-0-us-east-1.pooler.supabase.com`, port `5432`. Supabase says to copy this host from the dashboard's **Connect** panel rather than work it out from the region. See "Check the pooler host".
- Plan: Pro (the Go Biz Help organization's plan), on Micro compute. HandsFreeOS adds about $10 a month for Micro. The organization's $10 compute credit is already used by its other projects.

The apps never sign in to the database as `postgres`. The API signs in as `hfos_api` and the worker as `hfos_worker`. Inside every transaction, each one switches to a narrower role: `authenticated` for the API, `service_actor` for the worker. That way the database's row level security rules apply to every request.

The commands below use the Supabase CLI (`supabase`) and the Fly CLI (`fly`). Run them in Terminal on your Mac. "Before you start" at the top of this guide covers installing both and signing in to Fly.io.

### What is already done

- All 12 migrations in `supabase/migrations` are applied, from `20260911000100_foundation_roles_schemas.sql` to `20260913000200_email.sql`. The hosted history records each one under its file's version, so `supabase db push` treats them as applied.
- `hfos_api` and `hfos_worker` have their hosted passwords. Those passwords, the two connection strings built from them and the publishable key are in `.env.hosted`. It is a gitignored file at `~/Projects/HandsFreeOS/.env.hosted`, and it exists only on your Mac. The third role, `service_actor`, cannot sign in at all.
- On 2026-09-11 the API was tested end to end against this project through the session pooler.
- The storage buckets `attachments`, `imports` and `telephony` exist.
- The project signs sign-in tokens with ES256. That is the only algorithm the API and the worker accept.
- On 2026-09-12 you set these in the dashboard:
  - the Site URL and the two redirect URLs
  - the three email templates
  - passkeys
  - a minimum password length of 12
  - manual identity linking

  Only the dashboard can show these settings. Check them once with the steps in "Check the Auth settings".

- The project has no user accounts yet.

Still to do:

- Put the two connection strings and the worker's secret key into Fly, and the publishable values into Vercel.
- Send Auth email through Postmark (custom SMTP).
- Turn on Sign in with Google. The sign-in and sign-up pages always show **Continue with Google**, and it fails until this is done.
- Create your first account.

### Which app gets which value

| Value                                  | Where to find it                                                                 | Where it goes                                                                                                                         | Secret |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Project URL                            | `https://` + project ref + `.supabase.co`. It never changes.                     | API and worker: `SUPABASE_URL`, already in `apps/api/fly.toml` and `apps/worker/fly.toml`. Web: `NEXT_PUBLIC_SUPABASE_URL` in Vercel. | No     |
| Publishable key (`sb_publishable_...`) | **Project Settings** → **API Keys**, and `.env.hosted`                           | Web only: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in Vercel                                                                            | No     |
| API and worker addresses               | Fixed: `https://api.handsfreeos.com` and `https://hooks.handsfreeos.com`         | Web only: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WORKER_URL` in Vercel. Without them the web app calls `127.0.0.1`.                   | No     |
| Secret key (`sb_secret_...`)           | **Project Settings** → **API Keys** → **Secret keys**                            | Worker only: Fly secret `SUPABASE_SECRET_KEY` on `handsfreeos-worker`, plus your password manager                                     | Yes    |
| `hfos_api` connection string           | The `DATABASE_URL` line in `.env.hosted` (everything after the first `=`)        | API only: Fly secret `DATABASE_URL` on `handsfreeos-api`                                                                              | Yes    |
| `hfos_worker` connection string        | The `DATABASE_URL_WORKER` line in `.env.hosted` (everything after the first `=`) | Worker only: Fly secret `DATABASE_URL_WORKER` on `handsfreeos-worker`                                                                 | Yes    |
| JWKS URL and token issuer              | Worked out from the project URL                                                  | Nothing to set                                                                                                                        | No     |
| Database (`postgres`) password         | Reset it in **Database** → **Settings** when the CLI needs it                    | Your password manager only. The CLI uses it; no app does.                                                                             | Yes    |

Three rules:

- The secret key can read and change everything, and it ignores row level security. Only the worker gets it. The API refuses to start if any variable name contains `SECRET`. It stops with `The API process must never hold privileged keys. Remove: <names>`.
- The web app gets publishable values only. Never put the secret key or a database address in Vercel.
- None of these secrets ever go in the repository, a chat or an email. CI runs gitleaks over the whole git history and checks that the web build contains no `sb_secret_` key. Do not count on either to catch every key or password.

### Copy the publishable key and the secret key

1. Sign in at `https://supabase.com/dashboard`.
2. Open the **HandsFreeOS** project in the **Go Biz Help** organization.
3. In the left sidebar, open **Project Settings** (the gear icon).
4. Under **Configuration**, click **API Keys**. Direct link: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/settings/api-keys`.
5. Open the **Publishable and secret API keys** tab.

   You should see a **Publishable key** section with a key that starts with `sb_publishable_`, and a **Secret keys** section below it.

   The tab may show a **Create new API keys** button instead. If so, click it and confirm. That creates a publishable key and a secret key, both named `default`.

6. Copy the publishable key. It should match the key in `.env.hosted`. Save it in your password manager as "Supabase publishable key". Browsers are meant to see it, but it still never goes into a file in the repository.
7. Keep the publishable key for "The web app on Vercel". There it becomes `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, next to `NEXT_PUBLIC_SUPABASE_URL` set to `https://ybupfghakoszfcxhyrby.supabase.co`. Neither is a secret. The web app also needs `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WORKER_URL` there. Vercel builds `NEXT_PUBLIC_` values into the web app, so redeploy whenever you change one.
8. Give the worker its own secret key, so you can replace it later without touching anything else. In **Secret keys**, click **New secret key**.
9. In the **Create new secret API key** dialog, type `hfos_worker` in **Name**.
10. Click **Create API key**.
11. Copy the new key. Save it in your password manager as "Supabase secret key (worker)".

    HandsFreeOS does not use the `default` secret key. Do not copy it anywhere. You can leave it, or delete it once the worker runs with its own key.

The first time, the worker gets this key in Fly Part 6, together with its other secrets. Fly Part 6 also checks that the key works before it goes to Fly. Use steps 12 to 16 below when you set it on its own later, for example after you replace it.

The log check in step 16 only works once the worker has been deployed and has all its production secrets. Those are `DATABASE_URL_WORKER`, `SMTP_URL`, `WORKER_ENCRYPTION_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_ACCOUNT_TOKEN` and `POSTMARK_WEBHOOK_PASSWORD` (24 or more characters). Until then the log shows the error for the first missing value, for example `POSTMARK_SERVER_TOKEN and POSTMARK_ACCOUNT_TOKEN are required with EMAIL_TRANSPORT=postmark`, and the machine keeps restarting. If so, skip the log check and do it after the first deploy. "The worker refuses to start" in "Going live, and when something goes wrong" lists these errors.

12. In Terminal, run the command below. It loads the key into a shell variable, which keeps it off the screen and out of your shell history. Paste the key and press Return. Nothing appears while you paste.

    ```bash
    read -s SECRET_KEY
    ```

13. Set the key on the worker only:

    ```bash
    fly secrets set --app handsfreeos-worker SUPABASE_SECRET_KEY="$SECRET_KEY"
    ```

    You should see Fly update the worker's machines. Setting a secret restarts them. If the worker has not been deployed yet, Fly only stores the value, and there is nothing to restart.

14. Clear the variable:

    ```bash
    unset SECRET_KEY
    ```

15. If the worker has not been deployed yet, stop here.
16. Watch the worker's log. Press Control-C to stop watching.

    ```bash
    fly logs --app handsfreeos-worker
    ```

    You should see a `worker started` line that includes `"storage":true`, and no line saying `SUPABASE_SECRET_KEY is not set`. That line only shows that a key is set, not that it is right. To check the key itself, run steps 5 to 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6.

17. If you replaced an older worker key, delete the old key on the **API Keys** page now.

The tab for Supabase's legacy `anon` and `service_role` keys holds the old keys. HandsFreeOS does not use them. Supabase plans to retire them by the end of 2026.

### Check the token keys

The API and the worker check every sign-in token against the project's public keys. They work out both addresses from `SUPABASE_URL`, so there is nothing to set:

- JWKS URL: `https://ybupfghakoszfcxhyrby.supabase.co/auth/v1/.well-known/jwks.json`
- Issuer: `https://ybupfghakoszfcxhyrby.supabase.co/auth/v1`

Leave `SUPABASE_JWKS_URL` and `SUPABASE_JWT_ISSUER` unset. They exist only to override those defaults.

1. Fetch the public keys:

   ```bash
   curl -s https://ybupfghakoszfcxhyrby.supabase.co/auth/v1/.well-known/jwks.json
   ```

   You should see one key with `"alg":"ES256"` and `"kty":"EC"`. During a rotation you see two such keys, until you revoke the old one.

#### Rotating the signing key

You will rarely need this. The apps pick up new public keys on their own and cache them, so no deploy is needed.

Supabase throttles key changes for about 5 minutes after each one. If a button does not respond or is greyed out, wait and try again.

1. Open **Project Settings** → **JWT Keys** (`https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/settings/jwt`), then the **JWT Signing Keys** tab.
2. Click **Create Standby Key**.
3. In the **Create a new Standby Key** dialog, under **Choose signing algorithm:**, pick **ES256 (ECC)**. Never pick **RS256 (RSA)** or **HS256 (Shared Secret)**. The API and the worker accept ES256 only, so every sign-in would fail after the rotation.
4. Click **Create standby key**.
5. Wait at least 20 minutes so every cache has the new public key.
6. Click **Rotate keys**.

   You should see the old key move under **Previously used keys**.

7. Wait at least 1 hour 15 minutes: the one-hour token lifetime plus 15 minutes.
8. Under **Previously used keys**, open the old key's menu (the three dots).
9. Click **Revoke**.

   You should see the key move under **Revoked keys**.

### Database connection strings for the API and the worker

The API and the worker connect through Supabase's session pooler on port `5432`. The direct host (`db.ybupfghakoszfcxhyrby.supabase.co`) has only an IPv6 address. The transaction pooler on port `6543` is not used today (see "How many connections the apps use" for when you might switch). On the pooler, the user name is the role, a dot, and the project ref.

`.env.hosted` already holds both finished strings, so you copy them rather than build them. Fly Part 6 saves them in your password manager and gives them to Fly the first time. Use the steps below whenever you set or change them later.

1. Open `.env.hosted` in TextEdit. Finder hides files whose names start with a dot, so use this command:

   ```bash
   open -e ~/Projects/HandsFreeOS/.env.hosted
   ```

   You should see lines that start with `HFOS_API_DB_PASSWORD=` and `DATABASE_URL=`.

   Never commit, attach or paste `.env.hosted` anywhere.

2. If the `hfos_api` and `hfos_worker` passwords are not in your password manager yet, copy them there now, as "hfos_api database password" and "hfos_worker database password".
3. On the line that starts `DATABASE_URL=`, copy everything after the first `=`. That is the API's string. It starts with `postgresql://hfos_api.ybupfghakoszfcxhyrby:` and ends with `?sslmode=require`.

   If the file has no such line, build the string instead (see "Build a connection string by hand").

4. In Terminal, load the string into a shell variable. Run the command, paste the string and press Return. Nothing appears while you paste.

   ```bash
   read -s DB_URL
   ```

5. Set it on the API:

   ```bash
   fly secrets set --app handsfreeos-api DATABASE_URL="$DB_URL"
   ```

6. Back in TextEdit, copy everything after the first `=` on the line that starts `DATABASE_URL_WORKER=`. That is the worker's string. It starts with `postgresql://hfos_worker.ybupfghakoszfcxhyrby:`.
7. Load the worker's string the same way:

   ```bash
   read -s DB_URL
   ```

8. Set it on the worker:

   ```bash
   fly secrets set --app handsfreeos-worker DATABASE_URL_WORKER="$DB_URL"
   ```

9. Clear the variable:

   ```bash
   unset DB_URL
   ```

10. Close TextEdit without saving any change to the file.
11. Check the worker. It uses the database as soon as it starts. As in "Copy the publishable key and the secret key", this only works after the first deploy, with every worker secret set.

    ```bash
    fly logs --app handsfreeos-worker
    ```

    You should see `worker started`, and no `password authentication failed` or `worker pass crashed` lines.

12. Check the API by signing in at `https://app.handsfreeos.com`. First you need an account (see "Create your first account"). Until Auth email goes through Postmark, sign up with the address you use to sign in to Supabase. Vercel also needs `NEXT_PUBLIC_API_URL` set to `https://api.handsfreeos.com` and `NEXT_PUBLIC_WORKER_URL` set to `https://hooks.handsfreeos.com` (see "The web app on Vercel"). Without those two, the web app calls `127.0.0.1` and every page fails.

    You should see your workspace's home page with its data. Don't rely on `https://api.handsfreeos.com/healthz` for this check. It answers `"ok":true` without touching the database.

#### Check the pooler host

Do this once, and again for any new or copied project. Supabase says the host cannot be worked out from the region: the number after `aws-` is a pooler cluster, not part of the region.

1. In the dashboard, click **Connect** in the project's top bar.
2. Choose **Session pooler** and look at its URI.

   You should see a string like `postgresql://postgres.ybupfghakoszfcxhyrby:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres`.

   This panel changed recently. It may show a **Direct** tab with a **Connection Method** menu, where you set **Session pooler** and leave **Type** on **URI**. If the host is not `aws-0-us-east-1.pooler.supabase.com` (for example, it says `aws-1-us-east-1`), use the host it shows in every connection string: the API's, the worker's and the admin string in "Push with the Supabase CLI". Never give an app this `postgres.` string.

#### Build a connection string by hand

You only need this if `.env.hosted` is missing a string, or for a new or copied project. Put each role's password in place of its placeholder. If a password contains any character other than letters, digits, `-`, `.`, `_` or `~`, percent-encode that character. For example, `@` becomes `%40` and `/` becomes `%2F`. Otherwise the apps cannot read the string. Passwords made with `openssl rand -hex 32` need no encoding.

API (`hfos_api`):

```text
postgresql://hfos_api.ybupfghakoszfcxhyrby:<hfos_api password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Worker (`hfos_worker`):

```text
postgresql://hfos_worker.ybupfghakoszfcxhyrby:<hfos_worker password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Keep `?sslmode=require` at the end. The apps do not insist on an encrypted connection by themselves; that ending is what turns encryption on.

Never give an app the `postgres` user (`postgres.ybupfghakoszfcxhyrby`). The apps' startup check refuses only the plain `postgres` user, so it would not catch this. The app would then run with far more rights than it should.

#### How many connections the apps use

Each open app connection holds one pooler connection, and the pooler opens database connections up to its **Pool Size**. The API opens up to 10 connections per machine. The worker opens up to 7 per machine: 4 for its loops and 3 for its web server. Micro compute allows 60 database connections and 200 pooler clients. When the pool is full, extra connections wait up to a minute, then fail with `Max client connections reached` (or `MaxClientsInSessionMode`).

Fly usually starts two machines per app on the first deploy (the worker starts with one if you follow Fly Part 7). After that deploy, count them:

```bash
fly scale show --app handsfreeos-api
```

```bash
fly scale show --app handsfreeos-worker
```

You should see a `COUNT` column with each app's number of machines.

1. Open **Database** → **Settings**: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/database/settings`. If the page has moved, search the dashboard for "pool size".
2. In the **Connection pooling** section, find **Pool Size**.
3. Check that it is at least 10 for each API machine plus 7 for each worker machine. With two machines each, that is 34. If it is 15, for example, two busy API machines (up to 20 connections) go over it.
4. If it is lower, raise it and save. Supabase suggests giving the pool no more than about 80% of the database connections, which is 48 on Micro. If you need more than that, move to a larger compute size or run fewer machines.

Check the pool size again before you add machines to either app.

If you see `Max client connections reached` in a log:

1. Keep the API to one machine. Fly asks you to confirm. Type `y` and press Return.

   ```bash
   fly scale count 1 --app handsfreeos-api
   ```

2. If it still happens, move both apps to Supabase's transaction mode, on port `6543`. The code is written to work with it. First, in your password manager, change `:5432/` to `:6543/` in both saved strings.
3. Give the API its new string. Paste `DATABASE_URL=<new string>` without quotes, then press Return and Control-D. The API restarts.

   ```bash
   fly secrets import --app handsfreeos-api
   ```

4. Give the worker its new string. Paste `DATABASE_URL_WORKER=<new string>` without quotes, then press Return and Control-D. The worker restarts.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

5. If `.env.hosted` holds the full strings, make the same change on both lines there.
6. Check the worker's log.

   ```bash
   fly logs --app handsfreeos-worker --no-tail
   ```

   You should see `worker started`.

7. Check the API's health check.

   ```bash
   fly checks list --app handsfreeos-api
   ```

   You should see the check as passing. Then open **Customers** at `https://app.handsfreeos.com`. You should see your customer list.

### Change an app role password

Change a role's password in any of these cases:

- It may have leaked.
- You restored a backup (backups do not keep these passwords).
- You are setting up a new or copied project. The first migration creates both roles with local development passwords that are written in the repository. Those must never stay in place on a hosted project.

Postgres keeps one password per role. So there is a short gap between changing the password and restarting the app, and new connections fail during it. Do this at a quiet time. Connections that are already open keep working; only new sign-ins need the new password. Do one role at a time. The steps below change `hfos_worker`. For the API, use `hfos_api`, `handsfreeos-api`, `DATABASE_URL` and `HFOS_API_DB_PASSWORD` instead.

1. Make a new password. It has only letters and digits, so it needs no encoding.

   ```bash
   openssl rand -hex 32
   ```

2. Save it in your password manager as the new `hfos_worker` password. Keep the old one until the last step.
3. Open `.env.hosted` in TextEdit:

   ```bash
   open -e ~/Projects/HandsFreeOS/.env.hosted
   ```

4. Put the new password in both places it appears: on the `HFOS_WORKER_DB_PASSWORD` line, and inside the `DATABASE_URL_WORKER` line, between `hfos_worker.ybupfghakoszfcxhyrby:` and `@`. For a new or copied project whose file has no such lines, build the string instead (see "Build a connection string by hand"). Save the new full string in your password manager too.
5. Press Command-S to save the file.
6. Open a new, empty query in the SQL Editor: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/sql/new`.

   You should see an empty query editor.

7. Paste this line, with the new password in place of the placeholder:

   ```sql
   alter role hfos_worker with password '<new hfos_worker password>';
   ```

8. Click **Run**.

   You should see a success message and no rows.

   Postgres writes this command, password included, into the project's database logs. Anyone on the Supabase team can read it there until the logs expire.

9. Wait 30 seconds. The pooler keeps a copy of the old password for a short while.
10. In TextEdit, copy everything after the first `=` on the `DATABASE_URL_WORKER` line.
11. Load the string into a shell variable. Run the command, paste the string and press Return.

    ```bash
    read -s DB_URL
    ```

12. Set it on the worker. Fly restarts the worker with the new value.

    ```bash
    fly secrets set --app handsfreeos-worker DATABASE_URL_WORKER="$DB_URL"
    ```

13. Clear the variable:

    ```bash
    unset DB_URL
    ```

14. Check the log:

    ```bash
    fly logs --app handsfreeos-worker
    ```

    You should see `worker started` and no `password authentication failed` lines. When you change `hfos_api`, sign in at `https://app.handsfreeos.com` and open **Customers** instead; you should see your customer list.

    If it still fails after 2 minutes, compare the password in the string with the one in step 7. Then repeat steps 10 to 13 with the corrected string.

15. Delete the old password from your password manager.
16. In the SQL Editor's list of queries, look for this query. The editor may have saved it.
17. If it is there, open its menu and delete it, so the password does not stay in the dashboard. If the menu has moved, search the SQL Editor for the query.

### Apply new migrations

Every database change is a new file in `supabase/migrations`, named `<version>_<name>.sql` (for example `20260913000200_email.sql`). Supabase records each applied file's version in the table `supabase_migrations.schema_migrations`. Keep those versions equal to the file names. Otherwise a later push tries to run a file again.

Nothing applies migrations to the hosted database automatically. The Deploy workflow only ships the two Fly apps. So:

- Push a migration to the hosted database before the code that needs it reaches `main`. A push to `main` deploys as soon as CI passes.
- Write migrations so the code already running keeps working. Add new tables and columns first, and remove old ones in a later migration.
- Never change tables, policies or functions by hand in the SQL Editor. The only exceptions are role passwords, a role's expiry date (see "When something goes wrong" below) and the history fix in "If you used the Supabase connector instead".

#### One time: reset the database password

The CLI signs in as `postgres`, and that password was never shown to you. Reset it once. Nothing in HandsFreeOS uses it, so the apps are not affected.

1. Make a password of letters and digits only:

   ```bash
   openssl rand -hex 32
   ```

2. Save it in your password manager as "Supabase postgres password". Supabase cannot show it again.
3. In the dashboard's left sidebar, click **Database**.
4. Under **Configuration**, click **Settings**. Direct link: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/database/settings`. If the page has moved, look under **Project Settings** → **Database**, or search the dashboard for "database password".
5. In **Database password**, click **Reset password**.
6. Paste the password into the password field of the **Reset database password** dialog.
7. Click **Reset password**.

   You should see "Successfully updated database password".

Right after a reset, the pooler can refuse the new password for a few seconds. Do not reset it several times in a row, because each reset makes that delay longer.

#### Push with the Supabase CLI

1. Check the CLI:

   ```bash
   supabase --version
   ```

   You should see `2.117.0` (the version CI uses) or later. If the command is not found, install it as in "Before you start".

2. Go to the repo:

   ```bash
   cd ~/Projects/HandsFreeOS
   ```

3. Build the admin connection string. It is the session pooler string with the `postgres` user and the database password (percent-encoded if needed). Use the same pooler host as your other strings; if **Connect** shows a different host, use that one (see "Check the pooler host"). Never give this string to an app, Fly or Vercel.

   ```text
   postgresql://postgres.ybupfghakoszfcxhyrby:<database password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```

4. Load it into a shell variable. Run the command, paste the string and press Return.

   ```bash
   read -s DB_URL
   ```

5. Compare the files with the hosted history:

   ```bash
   supabase migration list --db-url "$DB_URL"
   ```

   You should see a Local and a Remote column with the same version on every row. The only exception is the new file you are about to push, which has no Remote version yet.

6. Preview the push:

   ```bash
   supabase db push --db-url "$DB_URL" --dry-run
   ```

   You should see "Would push these migrations:" followed by only your new file or files. If it lists a file that is already applied, stop and go to "If the history does not match".

7. Push:

   ```bash
   supabase db push --db-url "$DB_URL"
   ```

8. The CLI asks "Do you want to push these migrations to the remote database?". Type `Y` and press Return.

   You should see each new file applied and no errors.

9. Run the list again:

   ```bash
   supabase migration list --db-url "$DB_URL"
   ```

   You should see the new version in both columns.

10. Clear the variable:

    ```bash
    unset DB_URL
    ```

11. Now push or merge the code that needs the migration. Push it to `main` only after `supabase db push` finishes.

The README's "Hosted project" section describes another way to do the same thing. It links this folder to the project, and the link step asks for the database password. This Mac has never been linked. After linking, CLI commands aim at the hosted project by default, so take extra care.

```bash
supabase login
```

```bash
supabase link --project-ref ybupfghakoszfcxhyrby
```

```bash
supabase db push
```

Never run these against the hosted project:

- `supabase db push --include-seed`: seed data never goes to the hosted project.
- `supabase db reset --linked`: it wipes the hosted database.
- `supabase config push`: it replaces the hosted Auth settings with the local ones in `supabase/config.toml`. Those include localhost addresses (`http://localhost:3000`), passkeys for `localhost` and a limit of 2 emails an hour. It could also turn off Sign in with Google and custom SMTP (Postmark), because the local file has Google off and no SMTP settings. If the CLI ever asks you to confirm changes to Auth settings, answer no. Change Auth settings in the dashboard.
- `pnpm db:reset`, `pnpm db:seed`, `pnpm env:local` and `pnpm test:e2e`: they are for the local stack only.

#### If you used the Supabase connector instead

The Supabase connector that Claude uses can apply a migration with its `apply_migration` tool. It records its own version number, not the file's. After every migration applied through the connector, fix the record and check it:

1. In the **SQL Editor**, run:

   ```sql
   update supabase_migrations.schema_migrations
   set version = '<file version>'
   where name = '<name>';
   ```

   For example, for `20260913000200_email.sql` the file version is `20260913000200` and the name is `email`.

2. In Terminal, load the admin connection string (see step 3 of "Push with the Supabase CLI"). Run the command, paste the string and press Return.

   ```bash
   read -s DB_URL
   ```

3. Compare the files with the hosted history:

   ```bash
   supabase migration list --db-url "$DB_URL"
   ```

   You should see the same version in the Local and Remote columns.

4. Clear the variable:

   ```bash
   unset DB_URL
   ```

#### If the history does not match

The CLI can fix the history table without running any migration's SQL. Only mark a file as applied when you are sure its SQL already ran on the hosted database.

1. Load the admin connection string (see step 3 of "Push with the Supabase CLI"). Run the command, paste the string and press Return.

   ```bash
   read -s DB_URL
   ```

2. If a file already ran but Remote does not list its version, mark it as applied:

   ```bash
   supabase migration repair --status applied <version> --db-url "$DB_URL"
   ```

3. If Remote lists a version that matches no file (for example, one the connector recorded), mark it as reverted:

   ```bash
   supabase migration repair --status reverted <version> --db-url "$DB_URL"
   ```

4. Check the history again:

   ```bash
   supabase migration list --db-url "$DB_URL"
   ```

   You should see the same version in the Local and Remote columns on every row.

5. Clear the variable:

   ```bash
   unset DB_URL
   ```

### Check the Auth settings

You entered these on 2026-09-12. Only the dashboard shows them, so check them once now, and again after any change. Change Auth settings only in the dashboard, never with `supabase config push`. To change the web address itself, see "Keep the web address the same everywhere" in "The web app on Vercel".

#### URL Configuration

1. In the left sidebar, click **Authentication**.
2. Under **Configuration**, click **URL Configuration**. Direct link: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/url-configuration`.
3. Check that **Site URL** is `https://app.handsfreeos.com`. Every link in Auth emails starts with it. If you change it, click **Save changes**.
4. Check that **Redirect URLs** lists both of these:
   - `https://app.handsfreeos.com/auth/callback`: where Sign in with Google returns.
   - `https://app.handsfreeos.com/auth/confirm`: where the links in sign-up, password-reset and email-change emails land.
5. If one is missing, click the button that adds a redirect URL. It opens the **Add new redirect URLs** dialog.
6. Enter the missing address in the URL field.
7. Click **Save URLs**.

   You should see both addresses in the list.

Add other addresses (such as Vercel preview addresses or `http://localhost:3000`) only if they should be able to sign in against the hosted project. "Preview deployments" in "The web app on Vercel" explains why previews are not worth adding.

#### Email templates

Only three emails are customized. Their bodies are in `supabase/templates` and their subjects are in `supabase/config.toml`, so the dashboard needs both.

| Email                    | Subject                              | Body file                              |
| ------------------------ | ------------------------------------ | -------------------------------------- |
| **Confirm sign up**      | `Confirm your HandsFreeOS email`     | `supabase/templates/confirmation.html` |
| **Reset password**       | `Reset your HandsFreeOS password`    | `supabase/templates/recovery.html`     |
| **Change email address** | `Confirm your new HandsFreeOS email` | `supabase/templates/email_change.html` |

1. In Terminal, go to the repo:

   ```bash
   cd ~/Projects/HandsFreeOS
   ```

2. Open the email templates page: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/templates`. You can also reach it from **Authentication**: under **Notifications**, click **Emails**, then open the **Templates** tab.
3. Open **Confirm sign up**.
4. Check that its **Subject** matches the table.
5. Copy the body file to the clipboard:

   ```bash
   pbcopy < supabase/templates/confirmation.html
   ```

6. Replace the template body in the dashboard with the clipboard contents.
7. Save the template.

   You should see `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup` in the body. That is the button's link.

8. Repeat steps 3 to 7 for **Reset password**. Copy its body with the command below. Its link ends in `&type=recovery`.

   ```bash
   pbcopy < supabase/templates/recovery.html
   ```

9. Repeat steps 3 to 7 for **Change email address**. Copy its body with the command below. Its link ends in `&type=email_change`.

   ```bash
   pbcopy < supabase/templates/email_change.html
   ```

Leave the other templates (**Invite user**, **Magic link or OTP**, **Reauthentication**) on Supabase's defaults. Workspace invitations come from the worker, not from Supabase Auth.

#### Passkeys and sign-in rules

Passkeys have their own page: **Authentication** → **Passkeys** (`https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/passkeys`). Check that:

- **Enable Passkey authentication** is on.
- **Relying Party Display Name** is `HandsFreeOS`.
- **Relying Party ID** is `handsfreeos.com`.
- **Relying Party Origins** lists `https://app.handsfreeos.com`.

Never change the **Relying Party ID**. Every saved passkey is tied to it, and all of them stop working if it changes. Supabase marks passkeys as experimental, so this page may change.

The email sign-in rules are on **Authentication** → **Sign In / Providers** → **Email** (`https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/providers?provider=Email`). Check that:

- Minimum password length is `12`.
- **Confirm email** is on, so new accounts must confirm their address.

Look for these two on the same **Sign In / Providers** page. If they are not there, search the dashboard for "manual linking" or "anonymous":

- Manual identity linking is on.
- Anonymous sign-ins are off. The app refuses anonymous sessions anyway, with `Anonymous sessions cannot use HandsFreeOS.`

Test passkeys once you have an account (see "Create your first account"):

1. Sign in at `https://app.handsfreeos.com`.
2. Open **Settings**.
3. In **Passkeys**, click **Add passkey**.

   You should see your browser or password manager offer to save a passkey for `handsfreeos.com`.

Passkeys only work at `https://app.handsfreeos.com`. On your laptop, the local stack ties them to `localhost` instead. So open the local app at `localhost`, not `127.0.0.1`.

#### Sign in with Google

The sign-in and sign-up pages already show **Continue with Google**. It does not work until the Google provider is turned on in Supabase. That needs its own Google OAuth client with Supabase's callback address on it. This client and its redirect are separate from the Gmail client in "Connected mailboxes: Outlook and Gmail", whose redirect is on `hooks.handsfreeos.com`.

Put the sign-in client in its own Google Cloud project. The Gmail project stays in testing until Google's CASA review is done, and while a project is in testing, only its listed test users can sign in. Publishing the Gmail project instead would send its restricted Gmail scopes into review.

Google Cloud's pages change often. If a label below differs, search the console for the named item (for example "OAuth consent screen" or "Client ID").

1. In Google Cloud, create a new project named `HandsFreeOS Sign-in`.
2. In that project, set up the consent screen with the HandsFreeOS name and `handsfreeos.com` as an authorized domain, as in "Set up the Google Auth platform" in "Connected mailboxes: Outlook and Gmail". Add only the `openid`, `email` and `profile` scopes.
3. On its **Audience** page, publish the app so its status reads **In production**.
4. In Supabase, open `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/providers?provider=Google`. That is **Authentication** → **Sign In / Providers** → **Google**.
5. Copy the **Callback URL** it shows. It should be `https://ybupfghakoszfcxhyrby.supabase.co/auth/v1/callback`.
6. In Google Cloud, with the `HandsFreeOS Sign-in` project selected, open `https://console.cloud.google.com/auth/clients` (**Google Auth Platform** → **Clients**; older menus: **APIs & Services** → **Credentials**).
7. Create a new client.
8. Under **Application type**, choose **Web application**.
9. Under **Authorized JavaScript origins**, add `https://app.handsfreeos.com`.
10. Under **Authorized redirect URIs**, add the callback URL from step 5.
11. Click **Create**.
12. Save the **Client ID** and **Client secret** in your password manager as "Google sign-in client". The client secret goes only into Supabase and your password manager. Never put it into Fly, Vercel or the repository.
13. Back in Supabase, paste the client ID into the Google provider's client ID field.
14. Paste the client secret into its client secret field.
15. Turn the provider on.
16. Click **Save**.

    You should see Google's account chooser when you click **Continue with Google** at `https://app.handsfreeos.com/sign-in`.

### Send Auth email through Postmark

Until you do this, Supabase sends sign-up confirmations and password resets through its own test mail service. It sends at most 2 an hour, and only to members of the Supabase organization's team ("Email address not authorized" for anyone else). Real clients cannot confirm their accounts or reset their passwords.

Do this only after Postmark approves the account. Before approval, Postmark refuses mail to anyone outside your own domains, so sign-up confirmations and password resets would stop arriving, including your own. First, in "Email: Postmark":

- Get the Postmark account approved (Postmark Part A), so it can send to any address.
- Verify `handsfreeos.com` in Postmark (Postmark Part D). Supabase Auth email needs it, and so does the worker's platform mail from `alerts@handsfreeos.com`.

First make an SMTP token for Supabase. It keeps Supabase apart from the server API token, so changing that token later does not touch Supabase.

1. In Postmark, go to **Servers** → **HandsFreeOS Production** → **Default Transactional Stream**.
2. Open the **Settings** tab.
3. Scroll to the **SMTP** section.
4. Click **Generate an SMTP token**.

   You should see an Access Key and a Secret Key. Postmark shows the Secret Key only once.

5. Save both in your password manager as "Postmark SMTP token" straight away. Never commit it, and never put it on Fly.io, Vercel or GitHub.

If you cannot make an SMTP token, Supabase can use the server API token instead (from the production server's **API Tokens** tab, the same value the worker has as `POSTMARK_SERVER_TOKEN`): put it in both **Username** and **Password** below. The server API token is then in one more place to update when you change it.

Then point Supabase at Postmark. The field names below come from Supabase's and Postmark's help pages; if the screen differs, look for the custom SMTP settings.

6. In the left sidebar, click **Authentication**.
7. Under **Notifications**, click **Emails**, then open the **SMTP Settings** tab. Direct link: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/smtp`.
8. Turn on **Enable custom SMTP**.
9. Under **Sender details**, set **Sender email address** to `no-reply@handsfreeos.com`. Any address on `handsfreeos.com` works once Postmark has verified the domain.
10. Set **Sender name** to `HandsFreeOS`.
11. Under **SMTP provider settings**, set **Host** to `smtp.postmarkapp.com`.
12. Set **Port number** to `587`.
13. Leave **Minimum interval per user** at its default.
14. Paste the SMTP token's Access Key into **Username**.
15. Paste the SMTP token's Secret Key into **Password**. Mail then goes through the server's default transactional stream. Supabase does not show the password again after you save.
16. Click **Save changes**.

    You should see "Successfully updated settings". Supabase now limits Auth email to 30 an hour until you raise it.

17. Open the rate limits page: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/auth/rate-limits`. That is **Authentication** → **Rate Limits**.
18. Set **Rate limit for sending emails** to `100`. Emails over the limit are not sent, so raise it before a large launch.
19. Save the page.

    You should see "Rate limits successfully updated".

These emails go through Postmark's `outbound` stream, alongside business email. Their delivery events reach the worker, which ignores them because they belong to no workspace.

Test it with an address that is not on the Supabase team, such as a personal Gmail address. It must be on a real domain: Supabase refuses addresses on domains that have neither an MX record nor an address (A or AAAA) record, and addresses on example or test domains.

1. Open `https://app.handsfreeos.com/sign-up`.
2. Fill in **Full name**, **Work email** (the test address) and **Password** (at least 12 characters).
3. Click **Create account**.

   You should see **Check your email**. The email arrives from HandsFreeOS with the subject `Confirm your HandsFreeOS email`, and it appears in the Postmark server's Activity.

4. In the email, click **Confirm email**.

   You should land on the **Set up your business** page (`https://app.handsfreeos.com/onboarding`). You do not need to finish it for this test account.

5. Open `https://app.handsfreeos.com/forgot-password`.
6. Enter the same test address.
7. Click **Send reset link**.

   You should see "a reset link is on its way". The email arrives from `HandsFreeOS <no-reply@handsfreeos.com>` with the subject `Reset your HandsFreeOS password`, and it appears in the Postmark server's Activity.

8. In the email, click **Choose a new password**.

   You should land on `https://app.handsfreeos.com/reset-password`.

If an email does not arrive, see "Sign-in emails do not arrive" in "Going live, and when something goes wrong".

### Create your first account

The hosted project has no accounts yet. Several checks in this guide sign in with this one.

Before you start:

- The web app is live at `https://app.handsfreeos.com`, with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WORKER_URL` set (see "The web app on Vercel").
- `https://api.handsfreeos.com/healthz` answers with `"ok":true`, and the worker is running (see "Hosting: the API and the worker on Fly.io").
- Auth email goes through Postmark (see "Send Auth email through Postmark"). Before that, the confirmation email only reaches members of the Supabase organization's team, at most 2 an hour. If you sign up earlier, as Stage 5 of the go-live checklist does, use the address you use to sign in to Supabase.

1. Open `https://app.handsfreeos.com/sign-up`. From the sign-in page, click **Create an account** below the sign-in box.
2. Fill in **Full name**, **Work email** (your own work address) and **Password** (at least 12 characters).
3. Click **Create account**.

   You should see **Check your email**.

4. Open the email titled `Confirm your HandsFreeOS email`.
5. Click **Confirm email**. If Auth email already goes through Postmark, this also proves Supabase's SMTP settings work.

   You should land on the **Set up your business** page (`https://app.handsfreeos.com/onboarding`). If no email arrives within five minutes, see "Sign-in emails do not arrive" in "Going live, and when something goes wrong".

6. Fill in **Business name**. For the go-live test, use the business whose details you will send to the carriers.
7. Pick the **Industry**.
8. Pick the **Time zone**. Quiet hours for texts follow it.
9. Leave the agency switch as it is.
10. Click **Create business**.

    You should see your workspace's home page, at an address like `https://app.handsfreeos.com/app/w/<workspace id>`.

11. Open a private browser window and go to `https://app.handsfreeos.com/sign-in`.
12. Enter your **Email** and **Password**, and click **Continue**.

    You should land back in the workspace. Close the private window.

### Storage buckets

The migrations create three private buckets. There is nothing to create by hand.

| Bucket        | Holds                                                                        | Largest file | Who adds files                                         |
| ------------- | ---------------------------------------------------------------------------- | ------------ | ------------------------------------------------------ |
| `attachments` | Files and photos people add in the app (images, PDF, Word, Excel, text, CSV) | 25 MiB       | Signed-in people, only at paths the app reserved first |
| `imports`     | CSV files for customer imports                                               | 10 MiB       | Signed-in people, only at reserved paths               |
| `telephony`   | Text-message media, voicemail recordings and inbound email attachments       | 25 MiB       | The worker only                                        |

- Signed-in people can only read files that belong to their own workspaces. Only the worker deletes files, and it uses the secret key to do so.
- To check the buckets, click **Storage** in the left sidebar.

  You should see the three buckets, none of them public.

- Never make a bucket public or change its limits in the dashboard. Put any change in a new migration.
- Database backups do not include these files (see "Backups").

### Live updates

Migration `20260912000300_realtime_broadcast.sql` makes the database announce changes on a private channel for each workspace. Only that workspace's members can listen. The migration is in place on the hosted project. The web app uses only private channels, so you can also switch off public channels.

Before you start: sign in with your first account and add a lead to a pipeline in your workspace.

1. Open `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/realtime/settings`.
2. Turn off **Allow public access to channels**.
3. If the page has a save button, click it.
4. Open the pipeline board in two browser windows, signed in to the same workspace.
5. Move a lead in one window.

   You should see it move in the other window within a few seconds. If it does not, turn **Allow public access to channels** back on.

### Backups

- The Pro plan backs up the database every day and keeps the last 7 days. The backups are under **Database** → **Backups**, on the **Scheduled backups** tab. Direct link: `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/database/backups/scheduled`.
- Backups do not include Storage files, only the rows that point to them. A backup cannot bring back a deleted photo or recording.
- Backups do not keep the `hfos_api` and `hfos_worker` passwords.
- No backup holds the worker's `WORKER_ENCRYPTION_KEY`. Without it, the clients' Twilio credentials in a restored database cannot be opened. Keep the key in your password manager.
- Deleting the project deletes its backups.
- Point-in-time recovery restores the database to any moment, losing at most about 2 minutes of data. It is an add-on that costs about $100 a month for 7 days. It also needs at least the Small compute size (about $15 a month); the project is on Micro now (about $10 a month). For HandsFreeOS alone, that adds roughly $105 a month. The organization's Pro plan fee stays the same. Point-in-time recovery replaces the daily backups. Turn it on in **Project Settings** → **Add-ons** once clients depend on their data.

#### Restoring a daily backup

1. Open `https://supabase.com/dashboard/project/ybupfghakoszfcxhyrby/database/backups/scheduled`.
2. On the backup you want, click its restore button.
3. Read the **Restore from backup** dialog. Every change made after that backup is lost.
4. Click **Restore**.

   You should see the dashboard report that the project is restoring. The project is offline until the restore finishes.

5. Give both roles new passwords, one at a time, with the steps in "Change an app role password". The apps cannot sign in until you do.

   You should see `worker started` in the worker's log, and your data when you sign in at `https://app.handsfreeos.com`.

#### Keeping your own copy

A copy on your own disk also protects you if the project itself is lost. It holds the database only: photos, recordings and attachments in Storage are not in it. It does hold client information and sign-in data. Keep it on an encrypted disk (FileVault on) and outside the repository, and never email it.

1. Make a folder for the copies:

   ```bash
   mkdir -p ~/HandsFreeOS-backups
   ```

2. The CLI uses Docker for this, so start Colima (the Docker the local stack uses; see "Local development"):

   ```bash
   colima start
   ```

3. Go to the repo:

   ```bash
   cd ~/Projects/HandsFreeOS
   ```

4. Load the admin connection string (the one from "Push with the Supabase CLI"):

   ```bash
   read -s DB_URL
   ```

5. Save the schema. The repo's wrapper script points the CLI at Colima.

   ```bash
   node scripts/supabase.mjs db dump --db-url "$DB_URL" -f ~/HandsFreeOS-backups/schema-$(date +%F).sql
   ```

6. Save the data:

   ```bash
   node scripts/supabase.mjs db dump --db-url "$DB_URL" --data-only --use-copy -f ~/HandsFreeOS-backups/data-$(date +%F).sql
   ```

   You should see two new files with today's date in `~/HandsFreeOS-backups`.

7. Clear the variable:

   ```bash
   unset DB_URL
   ```

Restoring from this copy into a new project follows Supabase's "Backup and Restore using the CLI" guide. Get help before you try it.

### When something goes wrong

Startup errors from either app are listed under "The API refuses to start" and "The worker refuses to start" in "Going live, and when something goes wrong". These are the ones specific to Supabase:

- The API stops with `The API process must never hold privileged keys. Remove: SUPABASE_SECRET_KEY`. The secret key was set on the API. Remove it:

  ```bash
  fly secrets unset --app handsfreeos-api SUPABASE_SECRET_KEY
  ```

- You see `DATABASE_URL must not connect as the postgres role`, or the same error for `DATABASE_URL_WORKER`. The string uses the `postgres` user. Use `hfos_api.ybupfghakoszfcxhyrby` or `hfos_worker.ybupfghakoszfcxhyrby` instead.
- The worker logs `SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is`. Set the worker's secret key (see "Copy the publishable key and the secret key").
- You see `password authentication failed` right after a password change. The pooler still has the old password. Wait 30 seconds and try again. If it keeps happening, the password in the string is wrong or not percent-encoded.
- You see `Tenant or user not found`. The pooler host or the user name in the string is wrong. Copy the host from **Connect** (see "Check the pooler host"), and check that the user is `hfos_api.ybupfghakoszfcxhyrby` or `hfos_worker.ybupfghakoszfcxhyrby`. A bare `hfos_api` or `hfos_worker` fails.
- You see `unsupported or invalid secret format`. The role's password has an expiry date that has passed. Run this in the **SQL Editor**, then try again. If the failing role is `hfos_api`, use that name instead.

  ```sql
  alter role hfos_worker valid until 'infinity';
  ```

- The Vercel build fails, or the site shows an error, with ``NEXT_PUBLIC_SUPABASE_URL is not set (run `pnpm env:local`)``, or every page fails even though `https://api.handsfreeos.com/healthz` answers. A Vercel setting is missing. See "Environment variables" in "The web app on Vercel".
- Supabase refuses a sign-up for an address that looks fine. It refuses addresses on domains that have neither an MX record nor an address (A or AAAA) record, and addresses on example or test domains.

## Hosting: the API and the worker on Fly.io

The web app stays on Vercel at `https://app.handsfreeos.com`. The API and the worker run on Fly.io as two apps:

| Fly app              | Public address                  | What it does                                                                                      | Its files                                        |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `handsfreeos-api`    | `https://api.handsfreeos.com`   | The API the web app calls.                                                                        | `apps/api/fly.toml`, `apps/api/Dockerfile`       |
| `handsfreeos-worker` | `https://hooks.handsfreeos.com` | The background loops, plus the small web server that Twilio, Postmark, Microsoft and Google call. | `apps/worker/fly.toml`, `apps/worker/Dockerfile` |

How it fits together:

- The worker receives the providers' webhooks, so it never sleeps.
- Both apps run in Fly's Dallas region (`dfw`), each on a small machine (`shared-cpu-1x`, 512 MB). Fly Part 4 explains why you may want `iad` instead.
- Both images build from the repository root on Fly's own builders. You do not need Docker on your Mac.
- There is no `fly.toml` at the repository root. So every `fly` command in this section names the app with `--app`, or its file with `--config`.
- A deploy never touches the database. Migrations go to Supabase separately with `supabase db push` (see "Apply new migrations" in "The database: Supabase (hosted)"). All current migrations are already applied.
- Secrets never go in this repository. Each one lives in Fly.io, GitHub or Vercel, with a copy in your password manager. The one exception is the GitHub deploy token in Fly Part 9, which lives only in GitHub.

The first time, do the parts in order. The checklist in "Going live, and when something goes wrong" shows where they fit among the other sections.

### Before you start

You need:

- Terminal open in the repository root, the folder that holds `package.json` and `apps/`.
- Homebrew, `gh` and `openssl` (see "Before you start" at the top of this guide).
- Your password manager.
- A credit card for Fly.io.
- Logins for Cloudflare (which hosts DNS for `handsfreeos.com`), for the Supabase dashboard and for Vercel.
- These values. Without them, an app will not start:
  - The passwords for the `hfos_api` and `hfos_worker` database roles. The API needs the first, the worker the second. They are in `.env.hosted` at the repository root.
  - The Twilio master account's **Account SID** (starts with `AC`) and **Auth Token**. "Find the two values" in "The phone carrier: Twilio" says where to copy them. Save both in your password manager.
  - The Postmark server API token and account API token (see below).
- The Supabase secret key (see "Copy the publishable key and the secret key" in "The database: Supabase (hosted)"). The worker starts without it, but files, imports, photos, picture texts, voicemails and inbound email with attachments fail.

Set up part of Postmark first. In production the worker sends customer email through Postmark. It will not start unless `POSTMARK_SERVER_TOKEN`, `POSTMARK_ACCOUNT_TOKEN` and a `POSTMARK_WEBHOOK_PASSWORD` of 24 or more characters are set.

Before Fly Part 1, do only these parts of "Email: Postmark":

- Create the account and ask for approval (Postmark Part A).
- Create the production server, which comes with its inbound stream (Postmark Part B).
- Save the server API token and the account API token in your password manager (Postmark Part C).
- Add and verify the domains `mail.handsfreeos.com` and `handsfreeos.com` (Postmark Part D).

Skip its webhook parts for now. The webhooks need `https://hooks.handsfreeos.com` to answer, which only happens in Fly Part 8, and the worker app does not exist until Fly Part 3. Fly Part 6 makes the webhook password, checks that both Postmark tokens work, and gives the worker all three Postmark values. You set the webhooks (Postmark Parts G and H) after Fly Part 8, step 19.

### Fly Part 1: Install flyctl and log in

1. Check that Homebrew is installed.

   ```bash
   brew --version
   ```

   You should see a line that starts with `Homebrew`.

2. Install flyctl.

   ```bash
   brew install flyctl
   ```

3. Check the install.

   ```bash
   fly version
   ```

   You should see a version number, such as `v0.4.102`. The program answers to both `fly` and `flyctl`. GitHub Actions calls it `flyctl`.

4. If you have no Fly.io account yet, create one. This opens a sign-up form in your browser.

   ```bash
   fly auth signup
   ```

5. Log in. Your browser opens. Confirm there, and Terminal finishes on its own.

   ```bash
   fly auth login
   ```

6. Check which account is active.

   ```bash
   fly auth whoami
   ```

   You should see your email address.

To update flyctl later:

```bash
brew upgrade flyctl
```

Your Fly login can change everything in your account. Never copy the token that `fly auth token` prints into GitHub, a file or a chat. GitHub gets its own, narrower token in Fly Part 9.

### Fly Part 2: Create the organization and add a card

Use an organization that holds only these two apps. The GitHub token in Fly Part 9 can manage every app in its organization. A separate organization limits what that token can reach.

1. Create the organization. `handsfreeos` is an example name.

   ```bash
   fly orgs create handsfreeos
   ```

2. Find the organization's slug, the short lowercase ID that Fly commands use.

   ```bash
   fly orgs list
   ```

   You should see the new organization with its slug next to its name. Use that slug wherever this guide says `<org-slug>`.

3. Open `https://fly.io/dashboard` in your browser.
4. Switch to the new organization.
5. Open the organization's **Billing** section.
6. Add the card as the payment method.

   You should see the card listed as the organization's payment method.

Fly's dashboard labels may differ slightly from the names here. If a page has moved, look for the organization's billing or payment method settings.

Add the card before the first deploy. Without a card the account stays on a trial. Trial machines stop after 5 minutes, and apps stop after 7 days or 2 machine hours. The worker cannot run like that. Your bank may show a small temporary authorization from Fly.io. It is not a charge.

### Fly Part 3: Create the two apps

1. Go to the repository root. Change the path if your copy is somewhere else.

   ```bash
   cd ~/Projects/HandsFreeOS
   ```

2. Create the API app.

   ```bash
   fly apps create handsfreeos-api --org <org-slug>
   ```

3. Create the worker app.

   ```bash
   fly apps create handsfreeos-worker --org <org-slug>
   ```

4. Check that both exist.

   ```bash
   fly apps list
   ```

   You should see `handsfreeos-api` and `handsfreeos-worker`. They have no machines and no addresses until their first deploy.

If a name is taken, pick another one. Change `app =` in that app's `fly.toml` to match. Then use the new name wherever this guide says `handsfreeos-api` or `handsfreeos-worker`. The app's `.fly.dev` address changes with it.

### Fly Part 4: Decide the region before the first deploy

Both `fly.toml` files say `primary_region = "dfw"` (Dallas). The Supabase project is in `us-east-1` (Northern Virginia). Fly's `iad` region (Ashburn, Virginia) is next to it.

- **Keep `dfw`.** Pro: nothing to change. Con: every database call crosses the country, and each API request makes several. Dallas machines also cost about 25 percent more.
- **Switch to `iad`.** Pro: faster pages and a lower bill. Con: you change one line in each `fly.toml` and commit it before the first deploy.

Decide now, because the first deploy creates the machines in the primary region. To switch, run these from the repository root:

1. Change the region in both files.

   ```bash
   sed -i '' 's/primary_region = "dfw"/primary_region = "iad"/' apps/api/fly.toml apps/worker/fly.toml
   ```

2. Check the change.

   ```bash
   git diff
   ```

   You should see one line change from `dfw` to `iad` in each file.

3. Commit it.

   ```bash
   git commit -am "Run the API and the worker in iad, next to Supabase"
   ```

4. Push it.

   ```bash
   git push
   ```

   You should see the push finish. On GitHub, CI runs. When it passes, the Deploy workflow notes that `FLY_API_TOKEN` is not set and deploys nothing.

### Fly Part 5: Every setting each app reads

Nothing on Fly reads a `.env` file. The images contain none, because `.dockerignore` keeps every `.env` file and `supabase/signing_keys.json` out of what is sent to Fly's builder. Each setting comes from one of two places:

- **`[env]`**: a plain value already written in the app's `fly.toml`. It is committed to the repository, so it must never be a secret.
- **Fly secret**: a value you set with `fly secrets`. Fly stores it encrypted and never shows it again. Never commit it.

#### The API (`handsfreeos-api`)

| Name                  | How it is set | Required                                | Default if unset                                        | Where the value comes from                                                                           |
| --------------------- | ------------- | --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `[env]`       | Yes                                     | Not set (the Dockerfile also sets `production`)         | Already `production`                                                                                 |
| `HOST`                | `[env]`       | Yes, must be `0.0.0.0` on Fly           | `127.0.0.1` in the code. The Dockerfile sets `0.0.0.0`. | Already `0.0.0.0`                                                                                    |
| `PORT`                | `[env]`       | Yes, must match `internal_port = 4000`  | `4000` (the Dockerfile also sets `4000`)                | Already `4000`                                                                                       |
| `TRUST_PROXY`         | `[env]`       | Recommended                             | Off (on only when exactly `true`)                       | Already `true`. Fly's proxy passes on each visitor's address.                                        |
| `WEB_ORIGINS`         | `[env]`       | Yes, or the browser cannot call the API | `http://localhost:3000`                                 | Already `https://app.handsfreeos.com`. Separate several with commas.                                 |
| `SUPABASE_URL`        | `[env]`       | Yes, the API will not start without it  | None                                                    | Already `https://ybupfghakoszfcxhyrby.supabase.co`                                                   |
| `LOG_LEVEL`           | `[env]`       | No                                      | `info`                                                  | Already `info`                                                                                       |
| `DATABASE_URL`        | Fly secret    | Yes, the API will not start without it  | None                                                    | The session pooler string for the `hfos_api` role (Fly Part 6). It must not use the `postgres` role. |
| `SUPABASE_JWT_ISSUER` | Leave unset   | No                                      | `<SUPABASE_URL>/auth/v1`                                | Worked out from `SUPABASE_URL`                                                                       |
| `SUPABASE_JWKS_URL`   | Leave unset   | No                                      | `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`          | Worked out from `SUPABASE_URL`                                                                       |

`DATABASE_URL` is the API's only secret. At startup the API checks the name of every variable. It refuses to start if a name contains `SECRET`, `SERVICE_ROLE`, `SIGNING_KEY` or `ENCRYPTION_KEY`, or starts with `TWILIO_`, `POSTMARK_`, `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_` (upper or lower case). Its log then says `The API process must never hold privileged keys. Remove: <names>`. Fly's own variables (`FLY_*`, `PRIMARY_REGION`) are fine. Never run a worker secrets command with `--app handsfreeos-api`.

Both apps check sign-ins against Supabase's published signing keys and cache them. So rotating Supabase's signing keys needs no deploy.

#### The worker (`handsfreeos-worker`): plain values in `fly.toml`

| Name                 | Required                                                                                       | Default if unset                           | Value in `fly.toml` and why                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | Yes                                                                                            | Not set (the Dockerfile sets `production`) | `production`. Turns on every production check below.                                                                                                           |
| `WORKER_HTTP_PORT`   | Yes, must match `internal_port = 4100`                                                         | `4100`                                     | `4100`                                                                                                                                                         |
| `WORKER_HTTP_HOST`   | Yes (the default is already right)                                                             | `0.0.0.0` in production                    | `0.0.0.0`                                                                                                                                                      |
| `WORKER_PUBLIC_URL`  | Yes, must start with `https://` in production                                                  | `http://127.0.0.1:4100`                    | `https://hooks.handsfreeos.com`. Twilio signatures are checked against this exact address. Every webhook address the worker gives a provider is built from it. |
| `WEB_URL`            | Yes                                                                                            | `http://localhost:3000`                    | `https://app.handsfreeos.com`. Used for links in emails, and as the page mailbox sign-in returns to.                                                           |
| `WEB_ORIGINS`        | Yes                                                                                            | `http://localhost:3000`                    | `https://app.handsfreeos.com`. Lets the browser call the worker directly for number search and call tokens.                                                    |
| `SUPABASE_URL`       | Yes in practice. The worker starts without it, but files and the worker's sign-in checks fail. | None                                       | `https://ybupfghakoszfcxhyrby.supabase.co`                                                                                                                     |
| `MAIL_FROM`          | Yes                                                                                            | `HandsFreeOS <hello@handsfreeos.local>`    | `HandsFreeOS <alerts@handsfreeos.com>`. The sender of platform mail (invitations, alerts). `handsfreeos.com` must be a verified sender domain in Postmark.     |
| `TELEPHONY_PROVIDER` | Yes                                                                                            | `twilio` in production                     | `twilio`. Production refuses `fake`.                                                                                                                           |
| `LOG_LEVEL`          | No                                                                                             | `info`                                     | `info`                                                                                                                                                         |

#### The worker: Fly secrets it needs to start

The worker will not start if any of these is missing or malformed.

| Name                        | Where to copy the value from                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL_WORKER`       | The session pooler string for the `hfos_worker` role (Fly Part 6). It must not use the `postgres` role.                                            |
| `SMTP_URL`                  | Built from the Postmark server API token: `smtp://<server API token>:<server API token>@smtp.postmarkapp.com:587?requireTLS=true` (Fly Part 6).    |
| `WORKER_ENCRYPTION_KEY`     | You generate it once with `openssl rand -base64 32` and save it in your password manager (Fly Part 6). It must be 32 random bytes, base64 encoded. |
| `TWILIO_ACCOUNT_SID`        | The Twilio console, signed in as the master account: the **Account SID** (starts with `AC`).                                                       |
| `TWILIO_AUTH_TOKEN`         | The same place in the Twilio console: the **Auth Token**.                                                                                          |
| `POSTMARK_SERVER_TOKEN`     | Postmark, the production server's **API Tokens** tab: the server API token.                                                                        |
| `POSTMARK_ACCOUNT_TOKEN`    | Postmark, the account's **API Tokens**: the account API token. The worker uses it to add businesses' own domains.                                  |
| `POSTMARK_WEBHOOK_PASSWORD` | You make it up with `openssl rand -hex 24` (Fly Part 6). It must be 24 characters or more. The same value goes into Postmark's webhook addresses.  |

If the Twilio or Postmark screens have moved, search their consoles for "Account SID", "Auth Token" or "API Tokens".

#### The worker: Fly secrets for features

| Name                              | Required                                                      | Without it                                                                                                                                                                                                                                                               | Where to copy the value from                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SECRET_KEY`             | Yes in practice                                               | The worker starts but logs `SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is`. Picture texts, voicemails and any inbound email with attachments fail too. Such an email is refused whole, with a 500 error, until the key is set. | The Supabase dashboard for project `ybupfghakoszfcxhyrby`, **Project Settings** → **API Keys**: the secret key named `hfos_worker` (starts with `sb_secret_`). If the page has moved, search the dashboard for "API keys". Worker only. |
| `TWILIO_PRIMARY_PROFILE_SID`      | Only for local (10DLC) numbers                                | Local-number registrations are turned down. Toll-free numbers still work.                                                                                                                                                                                                | Twilio Trust Hub: HandsFreeOS's approved primary customer profile (starts with `BU`). See Twilio Step 4.                                                                                                                                |
| `MICROSOFT_OAUTH_CLIENT_ID`       | Only for Connect Outlook                                      | Connect Outlook shows a page titled "Outlook isn’t set up yet".                                                                                                                                                                                                          | The Microsoft Entra app registration: **Application (client) ID**. See "Connected mailboxes: Outlook and Gmail".                                                                                                                        |
| `MICROSOFT_OAUTH_CLIENT_SECRET`   | Only for Connect Outlook                                      | Same as above.                                                                                                                                                                                                                                                           | The Entra app, **Certificates & secrets**: the client secret value. It expires.                                                                                                                                                         |
| `GOOGLE_OAUTH_CLIENT_ID`          | Only for Connect Gmail                                        | Connect Gmail shows a page titled "Gmail isn’t set up yet".                                                                                                                                                                                                              | The Google Cloud OAuth client (type Web application).                                                                                                                                                                                   |
| `GOOGLE_OAUTH_CLIENT_SECRET`      | Only for Connect Gmail                                        | Same as above.                                                                                                                                                                                                                                                           | The same Google Cloud OAuth client (starts with `GOCSPX-`).                                                                                                                                                                             |
| `WORKER_ENCRYPTION_KEYS_PREVIOUS` | Only after a key rotation. Leave it unset on the first setup. | Nothing, until a key is rotated.                                                                                                                                                                                                                                         | Old `WORKER_ENCRYPTION_KEY` values from your password manager, separated by commas. Each must be a valid key, or the worker will not start.                                                                                             |

#### The worker: leave these unset

The defaults are right in production. Setting some of these changes real behavior.

| Name                                       | Default                                           | Why to leave it alone                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_TRANSPORT`                          | `postmark` in production                          | `smtp` is the local stand-in: domains verify themselves and delivery reports are fake. Production does not refuse it, so never set it to get around a missing Postmark token. |
| `MAILBOX_PROVIDER`                         | `real` in production                              | Production refuses `fake`.                                                                                                                                                    |
| `POSTMARK_WEBHOOK_USER`                    | `postmark`                                        | The user name in Postmark's webhook addresses.                                                                                                                                |
| `POSTMARK_MESSAGE_STREAM`                  | `outbound`                                        | Postmark's default stream for customer email.                                                                                                                                 |
| `MAIL_DOMAIN`                              | `mail.handsfreeos.com`                            | Must match the shared mail domain the database uses.                                                                                                                          |
| `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER` | Worked out from `SUPABASE_URL`                    | Nothing to change.                                                                                                                                                            |
| `WORKER_POLL_MS`                           | `1000` (one second between loop passes)           | Tuning only.                                                                                                                                                                  |
| `WORKER_BATCH_SIZE`                        | `20`                                              | Tuning only.                                                                                                                                                                  |
| `REGISTRATION_POLL_MS`                     | `900000` (15 minutes) with Twilio                 | How often carrier registrations are checked.                                                                                                                                  |
| `MAILBOX_BACKFILL_DAYS`                    | `30` (kept between 1 and 90)                      | How far back a new mailbox's first sync looks.                                                                                                                                |
| `MAILBOX_SYNC_MS`                          | Not set: Outlook every 5 minutes, Gmail every 2   | A test override. It changes how often every mailbox is checked.                                                                                                               |
| `UNANSWERED_ALERT_MS`                      | Not set: each workspace's own setting, in minutes | A demo override. It changes every workspace's alert timing.                                                                                                                   |
| `FAKE_APPROVAL_MS`                         | `3000`                                            | Used only by the fake carrier.                                                                                                                                                |

#### Settings outside Fly that must match

- **GitHub:** the repository secret `FLY_API_TOKEN` (Fly Part 9).
- **Vercel:** `NEXT_PUBLIC_API_URL` must be `https://api.handsfreeos.com`, and `NEXT_PUBLIC_WORKER_URL` must be `https://hooks.handsfreeos.com` (Fly Part 10). If the API address is missing, the web app tries `http://127.0.0.1:4000`. If the worker address is missing, number search, browser calls and mailbox sign-in try `http://127.0.0.1:4100`.
- **Providers:** Twilio, Postmark, Microsoft and Google must call `https://hooks.handsfreeos.com`, never `handsfreeos-worker.fly.dev`. A Twilio request sent to any other address fails with `403 Invalid signature`.
- **Never change `hooks.handsfreeos.com`.** The worker writes that address into every Twilio number it buys, and into each business's Messaging Service and browser-call (TwiML) app. Nothing re-points any of them afterwards (see "If the public address ever changes" in "The phone carrier: Twilio").

### Fly Part 6: Prepare the secret values and give them to Fly

Save every value in your password manager as you go. Never save them in a file inside the repository folder, and never commit them. CI scans every push to `main` and every pull request for leaked keys, and fails the build if it finds one. By then, though, the leaked key has to be replaced.

#### Get the two database connection strings

The apps connect through Supabase's session pooler, because the direct database host has only an IPv6 address. "Database connection strings for the API and the worker" in "The database: Supabase (hosted)" shows what the strings look like and how to build one by hand.

1. From the repository root, open `.env.hosted` in TextEdit. Its name starts with a dot, so Finder hides it.

   ```bash
   open -e .env.hosted
   ```

   You should see lines that start with `DATABASE_URL=` and `DATABASE_URL_WORKER=`. Do not type in this window.

2. Copy everything after `DATABASE_URL=` on its line.
3. Save it in your password manager, in the "hfos_api database password" entry, as the API's `DATABASE_URL`.
4. Copy everything after `DATABASE_URL_WORKER=` on its line.
5. Save it in the "hfos_worker database password" entry, as the worker's `DATABASE_URL_WORKER`.
6. Close TextEdit. If it asks about changes, do not save them.

If the file has no `DATABASE_URL=` or `DATABASE_URL_WORKER=` line, build that string with "Build a connection string by hand" in "The database: Supabase (hosted)". The passwords alone are on the `HFOS_API_DB_PASSWORD` and `HFOS_WORKER_DB_PASSWORD` lines.

Check two things:

- The user name before the password must be `hfos_api.ybupfghakoszfcxhyrby` or `hfos_worker.ybupfghakoszfcxhyrby`. Never use `postgres.ybupfghakoszfcxhyrby`. The apps refuse a plain `postgres` user, but their check does not catch the pooler's `postgres.` form.
- When you build a string by hand, percent-encode any character in the password other than letters, digits, `-`, `.`, `_` or `~`. For example, `@` becomes `%40`.

#### Generate and save the worker encryption key

The worker seals each client's Twilio subaccount token, browser-call key and mailbox sign-in with this key before storing them. Without the key, those values cannot be opened, and there is no way to recover them.

1. Generate the key.

   ```bash
   openssl rand -base64 32
   ```

   You should see one line of 44 characters ending in `=`.

2. Copy it into a new password manager entry named "Worker encryption key (current)", with the date you set it.
3. Open the entry again and check that the whole key was saved. Never make a second one for the same worker.

Never generate the key inside a `fly secrets` command (`WORKER_ENCRYPTION_KEY="$(openssl rand -base64 32)"`). That sets a key you never see, so you cannot save it.

If a key was already set that way, copy it once from the running worker, after its first deploy:

1. Print the key from the running worker.

   ```bash
   fly ssh console --app handsfreeos-worker -C 'printenv WORKER_ENCRYPTION_KEY'
   ```

   You should see one line of 44 characters.

2. Save it in your password manager as "Worker encryption key (current)". Never commit it or paste it anywhere else.
3. Press Command-K to clear the Terminal window.

#### Make up the Postmark webhook password

1. Generate it.

   ```bash
   openssl rand -hex 24
   ```

   You should see 48 characters: digits and the letters `a` to `f`. These characters need no escaping, which matters because the password goes inside Postmark's webhook addresses. A base64 password could contain `/`, `+` or `=`, which break it.

2. Save it in your password manager as "Postmark webhook password". Use the same value in Postmark's webhook addresses (Postmark Parts G and H).

#### Build `SMTP_URL`

Platform mail (invitations, alerts, reconnect emails) goes out through Postmark over SMTP:

```text
smtp://<server API token>:<server API token>@smtp.postmarkapp.com:587?requireTLS=true
```

- The Postmark server API token is both the user name and the password. It needs no escaping.
- Port 587 connects in plain text and then switches to encryption. `requireTLS=true` makes the worker refuse to send if the switch fails.
- Do not use `smtps://`. The worker's mail library reads `smtps://` as "encrypted from the start, on port 465", and Postmark offers ports 25, 2525 and 587, not 465. The worker still starts with `smtps://`, so that mistake only shows when platform mail fails.
- Mail sent this way goes through Postmark's default `outbound` stream, from `alerts@handsfreeos.com`. So `handsfreeos.com` must be a verified sender domain in Postmark, as well as `mail.handsfreeos.com`.

Save the finished string in your password manager as "Worker SMTP_URL".

#### Give the API its secret

`fly secrets import` reads the values you paste, so they never land in your Terminal history. `--stage` saves them for the first deploy.

1. Copy the API's `DATABASE_URL` string from your password manager.
2. Start the import.

   ```bash
   fly secrets import --stage --app handsfreeos-api
   ```

3. Type `DATABASE_URL=`, then paste the string right after it, with no space and no quotes. The line looks like this, with the real password in it:

   ```text
   DATABASE_URL=postgresql://hfos_api.ybupfghakoszfcxhyrby:<hfos_api password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```

4. Press Return, then Control-D.
5. Clear the clipboard.

   ```bash
   pbcopy < /dev/null
   ```

6. Check the secret.

   ```bash
   fly secrets list --app handsfreeos-api
   ```

   You should see exactly one name, `DATABASE_URL`, marked `Staged`. Fly never shows secret values, only a digest (a fingerprint of the value).

#### Check the Postmark tokens and the Supabase key

The worker only checks that these three values are present, never that they are right. With a wrong server token it still starts, and the mistake first shows when a customer email fails. A wrong account token only shows when a business adds its own domain. The `"storage":true` field in the worker's log only means that a Supabase key is set. So check all three now, before they go to Fly. Each check loads the value into a shell variable, which keeps it off the screen and out of your shell history.

1. Load the Postmark server API token. Run the command, paste the token from your password manager and press Return. Nothing appears while you paste.

   ```bash
   read -s T
   ```

2. Ask Postmark which server the token belongs to.

   ```bash
   curl -s -H "Accept: application/json" -H "X-Postmark-Server-Token: $T" https://api.postmarkapp.com/server
   ```

   You should see `HandsFreeOS Production` as the `Name` in the reply. If the reply has an `ErrorCode` of `10` instead, the token is wrong or was cut short. Copy it again from the server's **API Tokens** tab (Postmark Part C) and repeat steps 1 and 2.

3. Load the Postmark account API token the same way.

   ```bash
   read -s T
   ```

4. Ask Postmark for the account's domains.

   ```bash
   curl -s -H "Accept: application/json" -H "X-Postmark-Account-Token: $T" 'https://api.postmarkapp.com/domains?count=5&offset=0'
   ```

   You should see `mail.handsfreeos.com` and `handsfreeos.com` in the reply. If the reply has an `ErrorCode` of `10` instead, the token is wrong, was cut short, or is the server token. Copy the account token again (Postmark Part C) and repeat steps 3 and 4.

5. Load the Supabase secret key, from the "Supabase secret key (worker)" entry, the same way.

   ```bash
   read -s T
   ```

6. Ask Supabase for the project's storage buckets with it.

   ```bash
   curl -s -H "apikey: $T" https://ybupfghakoszfcxhyrby.supabase.co/storage/v1/bucket
   ```

   You should see `attachments`, `imports` and `telephony` in the reply. If you see an error or an empty list (`[]`) instead, the key is wrong or was cut short. Copy it again ("Copy the publishable key and the secret key" in "The database: Supabase (hosted)") and repeat steps 5 and 6.

7. Clear the variable.

   ```bash
   unset T
   ```

#### Give the worker its secrets

1. In your password manager, make a secure note named "handsfreeos-worker first import".
2. Put these nine lines in the note, one per line, without quotes. Copy each real value from its own entry.

   ```text
   DATABASE_URL_WORKER=postgresql://hfos_worker.ybupfghakoszfcxhyrby:<hfos_worker password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   SUPABASE_SECRET_KEY=<Supabase secret key>
   SMTP_URL=smtp://<server API token>:<server API token>@smtp.postmarkapp.com:587?requireTLS=true
   WORKER_ENCRYPTION_KEY=<encryption key>
   TWILIO_ACCOUNT_SID=<master account SID>
   TWILIO_AUTH_TOKEN=<master account auth token>
   POSTMARK_SERVER_TOKEN=<server API token>
   POSTMARK_ACCOUNT_TOKEN=<account API token>
   POSTMARK_WEBHOOK_PASSWORD=<webhook password>
   ```

3. Copy the nine lines from the note.
4. Start the import.

   ```bash
   fly secrets import --stage --app handsfreeos-worker
   ```

5. Paste the lines. Press Return, then Control-D.
6. Clear the clipboard.

   ```bash
   pbcopy < /dev/null
   ```

7. Check the secrets.

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   You should see all nine names, marked `Staged`.

8. Delete the "handsfreeos-worker first import" note from your password manager. Each value already has its own entry, and a leftover note would be one more copy of every secret that no rotation step updates.

Add the feature secrets later, as their own sections describe: `TWILIO_PRIMARY_PROFILE_SID` (Twilio Step 4) and the Microsoft and Google values ("Connected mailboxes: Outlook and Gmail"). After the first deploy, each secrets change restarts the worker.

### Fly Part 7: The first deploy, by hand

Do the first deploy by hand. You can watch it, keep the worker to one machine, and fix a missing secret before GitHub starts deploying on every push. The commands match what `.github/workflows/deploy.yml` runs. The worker goes first, so providers never reach a half-deployed pair. Then the API.

1. Switch to `main` and bring it up to date.

   ```bash
   git checkout main && git pull
   ```

2. Check for uncommitted changes.

   ```bash
   git status
   ```

   You should see `nothing to commit, working tree clean`. A hand deploy sends the folder as it is, including uncommitted changes. `.env` files are always left out.

3. Deploy the worker. This is the GitHub command plus `--ha=false`, which makes one machine instead of Fly's default two.

   ```bash
   fly deploy . --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --remote-only --wait-timeout 300 --ha=false
   ```

   You should see the image build on Fly's builder, then one machine start and pass its health check. The command ends without an error. The first build can take several minutes. If the command ends with an error instead, go on to step 4 to see why.

4. Read the worker's startup lines.

   ```bash
   fly logs --app handsfreeos-worker --no-tail
   ```

   You should see a line containing `"msg":"worker started"` with `"publicUrl":"https://hooks.handsfreeos.com"`, `"telephony":"twilio"`, `"email":"postmark"`, `"mailboxes":"real"` and `"storage":true`. `"storage":true` only means a Supabase key is set. "Check the Postmark tokens and the Supabase key" in Fly Part 6 is what shows that the key and the tokens work.

5. If step 3 ended with an error, or step 4 shows no `worker started`, look up the message under "The worker refuses to start" in "Going live, and when something goes wrong" and do what its row says. When the fix is a secret, start a staged import:

   ```bash
   fly secrets import --stage --app handsfreeos-worker
   ```

   Paste only the corrected `NAME=value` line, without quotes. Press Return, then Control-D. Then run step 3 again.

6. Deploy the API. This is exactly the GitHub command.

   ```bash
   fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --remote-only --wait-timeout 300
   ```

   You should see the build, then the machines start and pass their health checks. On a first deploy Fly makes two API machines. One stays running. The other stops when idle and costs only cents. If the command ends with an error, read the API's log:

   ```bash
   fly logs --app handsfreeos-api --no-tail
   ```

   Look up the message under "The API refuses to start" in "Going live, and when something goes wrong". To correct `DATABASE_URL`, start a staged import, paste the corrected line, press Return, then Control-D, and run this step again:

   ```bash
   fly secrets import --stage --app handsfreeos-api
   ```

7. Check the worker's machine.

   ```bash
   fly status --app handsfreeos-worker
   ```

   You should see one machine in the `started` state.

8. Check the API's machines.

   ```bash
   fly status --app handsfreeos-api
   ```

   You should see two machines. One is `started`. The other may be `stopped`.

9. Check that the worker's secrets are live.

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   You should see every name marked `Deployed`. If a name shows `Staged` or `Unknown` but step 4 showed `worker started`, the worker already has its values. Go on. If step 4 did not show `worker started`, apply the staged values:

   ```bash
   fly secrets deploy --app handsfreeos-worker
   ```

10. Check that the API's secret is live.

    ```bash
    fly secrets list --app handsfreeos-api
    ```

    You should see `DATABASE_URL` marked `Deployed`. If it shows `Staged` or `Unknown`, step 11 settles it: the API only answers there when it has its value.

11. Try the API at its Fly address.

    ```bash
    curl -fsS https://handsfreeos-api.fly.dev/healthz
    ```

    You should see `{"ok":true,"service":"api","time":"..."}` with the current time.

12. Try the worker at its Fly address.

    ```bash
    curl -fsS https://handsfreeos-worker.fly.dev/healthz
    ```

    You should see `{"ok":true}`. The API adds the service name and the time; the worker does not.

Use the `.fly.dev` addresses for checks only. Later deploys keep the number of machines you have now. Fly adds a second machine only on an app's first deploy, or after the app has been scaled to zero.

### Fly Part 8: Point the domains and get certificates

You add the records below at the company that hosts DNS for `handsfreeos.com`. Today that is Cloudflare. If an `app` record for Vercel or any Postmark records already exist, leave them alone.

The A and AAAA records in steps 10 to 13 are what Fly recommends. Add both for each name. Fly uses them to check that the name points at your app before it issues the certificate. To use CNAME records instead, see "If you would rather use a CNAME" after the steps.

On Cloudflare, set all four records to **DNS only** (grey cloud). A proxied record (orange cloud) needs an extra `_fly-ownership` TXT record and the SSL/TLS mode **Full (strict)**. The **Flexible** mode causes redirect loops.

1. Find the DNS host.

   ```bash
   dig +short NS handsfreeos.com
   ```

   You should see two or more name server names. The end of each name shows the company. Today they end in `ns.cloudflare.com`.

2. Sign in to that company's website and open the DNS records for `handsfreeos.com`.
3. Check whether the domain has CAA records, which limit who may issue certificates for it. Fly's certificates come from Let's Encrypt, and so do Vercel's. If CAA records exist and none allows Let's Encrypt, `fly certs check` never shows the certificate as issued.

   ```bash
   dig caa handsfreeos.com +short
   ```

   If this prints nothing, or prints a line that contains `letsencrypt.org`, skip to step 6.

4. Add one more CAA record at your DNS provider for the bare domain: name `@` (or `handsfreeos.com` if your provider asks for the full name). If the form has separate boxes, enter flag `0`, tag `issue` and value `letsencrypt.org`. If it has one value box, enter `0 issue "letsencrypt.org"`.
5. Run the `dig caa` command from step 3 again.

   You should see `0 issue "letsencrypt.org"` among the results.

6. Check the API's addresses.

   ```bash
   fly ips list --app handsfreeos-api
   ```

   You should see a shared IPv4 address and an IPv6 address. The first deploy adds both. Fly cannot issue a certificate without them. If the IPv4 line is missing, add a shared one. It is free:

   ```bash
   fly ips allocate-v4 --shared --app handsfreeos-api
   ```

   If the IPv6 line is missing, add one:

   ```bash
   fly ips allocate-v6 --app handsfreeos-api
   ```

   Do not buy a dedicated IPv4 address ($2 a month). HTTPS works on the shared one.

7. Check the worker's addresses.

   ```bash
   fly ips list --app handsfreeos-worker
   ```

   You should see a shared IPv4 address and an IPv6 address. If the IPv4 line is missing, add a shared one:

   ```bash
   fly ips allocate-v4 --shared --app handsfreeos-worker
   ```

   If the IPv6 line is missing, add one:

   ```bash
   fly ips allocate-v6 --app handsfreeos-worker
   ```

8. Ask Fly for the API's certificate.

   ```bash
   fly certs add api.handsfreeos.com --app handsfreeos-api
   ```

   You should see `Certificate created for api.handsfreeos.com`, then `Recommended DNS setup:` with an `A` line (an IPv4 address) and an `AAAA` line (an IPv6 address). Keep this output on screen, or copy the two addresses into a note. They are not secret.

9. Ask Fly for the worker's certificate.

   ```bash
   fly certs add hooks.handsfreeos.com --app handsfreeos-worker
   ```

   You should see `Certificate created for hooks.handsfreeos.com`, then an `A` line and an `AAAA` line for it.

10. At your DNS host, add an **A** record named `api`. Set its value to the IPv4 address from step 8.
11. Add an **AAAA** record named `api`. Set its value to the IPv6 address from step 8.
12. Add an **A** record named `hooks`. Set its value to the IPv4 address from step 9.
13. Add an **AAAA** record named `hooks`. Set its value to the IPv6 address from step 9.
14. Check the API's DNS.

    ```bash
    dig +short api.handsfreeos.com
    ```

    You should see the IPv4 address from step 8. If you used a CNAME, you see its target first, then one or more addresses. New records can take a while to appear, depending on your DNS host.

15. Check the worker's DNS.

    ```bash
    dig +short hooks.handsfreeos.com
    ```

    You should see the IPv4 address from step 9.

16. Check the API's certificate.

    ```bash
    fly certs check api.handsfreeos.com --app handsfreeos-api
    ```

    You should see that the certificate is issued and DNS is configured. If not, wait a few minutes and run it again. The app's **Certificates** page in the Fly dashboard shows the same status. If it never shows as issued, go back to step 3 and check the CAA records.

17. Check the worker's certificate.

    ```bash
    fly certs check hooks.handsfreeos.com --app handsfreeos-worker
    ```

    You should see that the certificate is issued.

18. Try the API at its real address.

    ```bash
    curl -fsS https://api.handsfreeos.com/healthz
    ```

    You should see `{"ok":true,"service":"api","time":"..."}`.

19. Try the worker at its real address.

    ```bash
    curl -fsS https://hooks.handsfreeos.com/healthz
    ```

    You should see `{"ok":true}`.

Wait until step 19 works. Then set Postmark's two webhook addresses (Postmark Parts G and H), and add the Microsoft and Google redirect addresses if you have not yet (see "Connected mailboxes: Outlook and Gmail"). Twilio needs nothing from you. The worker gives each number its addresses when it buys it, so buy the first number in the app only after step 19 works.

The certificates come from Let's Encrypt, and Fly manages them for you. Do not remove and re-add the same hostname over and over, because Let's Encrypt allows only 5 duplicate certificates a week. To see each app's certificates:

```bash
fly certs list --app handsfreeos-api
```

```bash
fly certs list --app handsfreeos-worker
```

#### If you would rather use a CNAME

A CNAME record takes the place of the A and AAAA records in steps 10 to 13 for that name. Then carry on with step 14. Ask Fly for the exact target. Do not guess it. Use the target from the `CNAME Record` option in this output, and use either the CNAME or the A and AAAA records for a name, never both. The same commands print the records again if you lose them.

```bash
fly certs setup api.handsfreeos.com --app handsfreeos-api
```

```bash
fly certs setup hooks.handsfreeos.com --app handsfreeos-worker
```

### Fly Part 9: Let GitHub deploy

The Deploy workflow uses one token, `FLY_API_TOKEN`, for both apps. Until that repository secret exists, each run only prints `FLY_API_TOKEN is not set, so nothing was deployed.`

It must be an **organization** token. A deploy token (`fly tokens create deploy`) covers only one app, so the workflow's other deploy would fail. Fly's own GitHub guide shows a deploy token, which does not fit this repository.

1. Create the token. `8760h` is one year. Without `--expiry` the token lasts 20 years.

   ```bash
   fly tokens create org --org <org-slug> --name "GitHub Actions deploy" --expiry 8760h
   ```

   You should see a long token that starts with `FlyV1 `.

2. Copy the whole token, including `FlyV1` and the space after it. Do not save this token in your password manager. It lives only in GitHub. If you lose it, make a new one.
3. Store it in GitHub. `gh` asks you to paste the value. Paste it and press Return.

   ```bash
   gh secret set FLY_API_TOKEN --repo gobizhelp/handsfreeos
   ```

   To do it in the browser instead, open the repository and go to **Settings** → **Secrets and variables** → **Actions**, click the **Secrets** tab, then **New repository secret**. Enter `FLY_API_TOKEN` as the **Name**, paste the token into **Secret**, and click **Add secret**.

4. Check it.

   ```bash
   gh secret list --repo gobizhelp/handsfreeos
   ```

   You should see `FLY_API_TOKEN` in the list.

5. Put the token's expiry date in your calendar. When it lapses, deploys fail until you make a new token.
6. Run the Deploy workflow once to prove it works.

   ```bash
   gh workflow run Deploy --repo gobizhelp/handsfreeos --ref main
   ```

7. Watch the run until it ends. Pick the newest Deploy run and press Return. If `gh` says no runs are in progress, wait a few seconds and run it again.

   ```bash
   gh run watch --repo gobizhelp/handsfreeos
   ```

   You should see each step get a check mark, and the run end successfully after several minutes. On GitHub, **Actions** → **Deploy** shows the same run with a green check. Its job **API and worker to Fly.io** shows the step **Deploy the worker (webhooks first, so providers never hit a half-deployed pair)**, then **Deploy the API**.

The token lives only in GitHub. Never paste it into a file or a workflow. If it leaks or is lost, make a new one and store it as in step 3. Then find the old token's ID:

```bash
fly tokens list --scope org --org <org-slug>
```

Revoke the old token:

```bash
fly tokens revoke <token ID>
```

### Fly Part 10: Point the web app at the API and the worker

The web app finds the two Fly apps through two Vercel settings: `NEXT_PUBLIC_API_URL` (`https://api.handsfreeos.com`) and `NEXT_PUBLIC_WORKER_URL` (`https://hooks.handsfreeos.com`). Vercel builds these values into the web app, so a change takes effect only after a new Vercel deploy. "The web app on Vercel" sets them, with the rest of the web app's settings, when it creates the project. If the project already exists, add or check them with "Environment variables" and "Redeploy after a change" in that section.

After the redeploy:

1. Sign in at `https://app.handsfreeos.com` with the account from "Create your first account" in "The database: Supabase (hosted)", and open **Customers**.

   You should see your customer list. That proves the web app reaches the API.

2. Open **Settings** → **Email** and click **Connect Outlook**.

   You should land on a page at `hooks.handsfreeos.com`: either Microsoft's sign-in, or a page titled "Outlook isn’t set up yet". That proves the web app reaches the worker. You can close it without signing in. If the address starts with `http://127.0.0.1:4100`, `NEXT_PUBLIC_WORKER_URL` is missing or the redeploy did not run.

### Every deploy after that

- A push to `main` runs CI. When CI passes, the Deploy workflow ships the commit CI checked: the worker first, then the API. CI can take up to 45 minutes.
- Only one deploy runs at a time. A deploy that starts while another is running waits for it to finish. At most one run waits. If another arrives while one is already waiting, GitHub cancels the older waiting run, and only the newest commit ships. A cancelled Deploy run is normal.
- If the worker deploy fails, the API deploy does not run.
- To run the workflow by hand in GitHub, go to **Actions** → **Deploy** → **Run workflow**, leave the branch on `main`, and click the green **Run workflow** button. Or run it from Terminal. A hand run skips the CI check and ships the newest commit on the branch you pick.

  ```bash
  gh workflow run Deploy --repo gobizhelp/handsfreeos --ref main
  ```

- To deploy from your Mac, start from a clean, up-to-date `main` (Fly Part 7, steps 1 and 2). Then run the same commands as GitHub, worker first:

  ```bash
  fly deploy . --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile --remote-only --wait-timeout 300
  ```

  ```bash
  fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --remote-only --wait-timeout 300
  ```

- When a change adds a file to `supabase/migrations`, apply its migration before you push that change to `main`. A push to `main` deploys on its own, and deploys never run migrations. Follow "Apply new migrations" in "The database: Supabase (hosted)", and push the code to `main` only after `supabase db push` finishes.

### Health checks

Each `fly.toml` tells Fly to call `GET /healthz` every 30 seconds, with a 5-second timeout. After a machine starts, Fly waits 10 seconds (API) or 15 seconds (worker) before the first check.

- A machine that fails its check stops getting traffic until it passes again. Fly does not restart it.
- Fly runs only the checks in `fly.toml`. Treat the `HEALTHCHECK` lines in the Dockerfiles as unused on Fly.
- `/healthz` only proves the program is running. Neither app checks the database there, and the worker does not check its loops. So a check can pass while the database connection is broken.

After every deploy:

1. Check the API's health check.

   ```bash
   fly checks list --app handsfreeos-api
   ```

   You should see the check as passing.

2. Check the worker's health check.

   ```bash
   fly checks list --app handsfreeos-worker
   ```

   You should see the check as passing.

3. Run the two `curl` commands from Fly Part 8, steps 18 and 19. You should see the same answers.

4. Read the worker's recent log.

   ```bash
   fly logs --app handsfreeos-worker --no-tail
   ```

   You should see `worker started` and no `worker pass crashed`.

5. Sign in at `https://app.handsfreeos.com` with the account from "Create your first account" in "The database: Supabase (hosted)", and open **Customers**.

   You should see your customer list. That proves the API can reach the database.

### Reading logs

1. Stream the worker's log live. Press Control-C to stop.

   ```bash
   fly logs --app handsfreeos-worker
   ```

2. Show the API's recent log without streaming.

   ```bash
   fly logs --app handsfreeos-api --no-tail
   ```

To see one machine's log, add `--machine <machine id>` to the `fly logs` command. To find the IDs:

```bash
fly machines list --app handsfreeos-api
```

```bash
fly machines list --app handsfreeos-worker
```

Add `--json` for raw lines. In the Fly dashboard, the app's live logs page shows the same stream (Fly's documentation calls it **Live Tail**; the dashboard may label it **Live Logs**). To open the dashboard for an app:

```bash
fly dashboard --app handsfreeos-worker
```

You can search older logs for 7 days in Fly's Grafana at `https://fly-metrics.net`. The app's dashboard may link to it as **Search logs in Grafana**.

Both apps log one JSON object per line. The message is in the `msg` field. `"level":50` is an error, `40` a warning and `30` information.

#### Messages worth knowing

| Log message                                                                                                                                                                                                       | What it means                                                                                                                                                 | What to do                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker started`                                                                                                                                                                                                  | The worker is up. The line shows `publicUrl`, its providers (`telephony`, `email`, `mailboxes`) and whether `storage` is set.                                 | Check that `publicUrl` is `https://hooks.handsfreeos.com`, `telephony` is `twilio`, `email` is `postmark`, `mailboxes` is `real` and `storage` is `true`. |
| `worker stopping: closing the listener, then finishing the current pass`                                                                                                                                          | A normal stop during a deploy or restart.                                                                                                                     | Nothing.                                                                                                                                                  |
| `worker pass crashed`                                                                                                                                                                                             | One loop pass failed. The health check stays green.                                                                                                           | Read the `err` field. It is often a database problem. If it repeats, save the lines for a developer.                                                      |
| `worker http error`                                                                                                                                                                                               | The worker answered a provider or the browser with a 500 error, `Something went wrong on our side.`                                                           | Read `err`. If it says `No key <id> to open this value. Add the old key to WORKER_ENCRYPTION_KEYS_PREVIOUS.`, an old encryption key is missing.           |
| `outbox handler failed`                                                                                                                                                                                           | A background job failed. The worker tries each job 5 times in all, waiting 5, 10, 20 and 40 seconds between tries, then gives up. `eventType` says which job. | Read `err`.                                                                                                                                               |
| `webhook delivery failed`                                                                                                                                                                                         | A stored webhook failed to process. The worker tries it 5 times in all, with the same waits, then gives up. `kind` says which provider.                       | Read `err`.                                                                                                                                               |
| An `err` field containing `Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY for the worker`, on a `worker http error`, `webhook delivery failed`, `outbox handler failed` or `job failed` line | The worker has no Supabase secret key, so it cannot store or remove files. Inbound email with attachments is refused.                                         | Set `SUPABASE_SECRET_KEY` on the worker.                                                                                                                  |
| `SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is`                                                                                                                         | The worker has no Supabase secret key.                                                                                                                        | Set `SUPABASE_SECRET_KEY` on the worker.                                                                                                                  |
| `rejected an unsigned or mis-signed webhook`                                                                                                                                                                      | A Twilio request failed its signature check and got `403 Invalid signature`. The line has the path and the `accountSid`.                                      | See "Twilio webhooks are rejected" in "Going live, and when something goes wrong".                                                                        |
| `rejected an inbound mail webhook without the right credentials` or `rejected a mail event webhook without the right credentials`                                                                                 | Postmark's webhook password does not match `POSTMARK_WEBHOOK_PASSWORD`. A 403 tells Postmark to stop retrying, so that mail is lost.                          | See "Postmark webhooks are rejected" in "Going live, and when something goes wrong".                                                                      |
| `refused a browser call that call.start did not record`                                                                                                                                                           | A browser call was refused.                                                                                                                                   | See "Calls do not ring, or cannot be placed" in "Going live, and when something goes wrong".                                                              |
| `a mailbox did not connect`                                                                                                                                                                                       | An Outlook or Gmail sign-in failed at the last step.                                                                                                          | See "When a connection fails" in "Connected mailboxes: Outlook and Gmail".                                                                                |
| `mailbox sync failed`                                                                                                                                                                                             | An Outlook or Gmail mailbox could not sync.                                                                                                                   | See "When a sign-in stops working" in "Connected mailboxes: Outlook and Gmail".                                                                           |
| `no Outlook notifications for now`                                                                                                                                                                                | Microsoft refused the change notifications. Outlook still syncs every five minutes, and the worker tries again about 6 hours later.                           | Check that `hooks.handsfreeos.com` answers over HTTPS.                                                                                                    |
| `Max client connections reached` or `MaxClientsInSessionMode`                                                                                                                                                     | Too many database connections through the session pooler.                                                                                                     | See "How many connections the apps use" in "The database: Supabase (hosted)".                                                                             |

#### Errors that stop an app from starting

If an app cannot start, its machine keeps restarting and the deploy fails its health check. The log shows why. Every startup error, in the order the apps check them, with its fix, is listed under "The API refuses to start" and "The worker refuses to start" in "Going live, and when something goes wrong".

### Rolling back

Fly's docs describe no rollback command. Instead you redeploy an earlier image.

1. List the API's releases with their images.

   ```bash
   fly releases --app handsfreeos-api --image
   ```

   You should see the releases, newest first, each with an image such as `registry.fly.io/handsfreeos-api:deployment-...`.

2. Copy the image of the last release that worked.

3. Redeploy that image from the repository root. Nothing is rebuilt.

   ```bash
   fly deploy --app handsfreeos-api --config apps/api/fly.toml --image '<image reference>'
   ```

   You should see the machines update and pass their health checks.

4. To roll back the worker instead, list its releases.

   ```bash
   fly releases --app handsfreeos-worker --image
   ```

5. Copy the image of the last worker release that worked.

6. Redeploy it.

   ```bash
   fly deploy --app handsfreeos-worker --config apps/worker/fly.toml --image '<image reference>'
   ```

   You should see the machine update and pass its health check. `fly logs --app handsfreeos-worker --no-tail` should show `worker started`.

7. Stop GitHub from shipping the bad commit again. Either revert the commit (steps 8 to 10) or pause the Deploy workflow (steps 11 and 12). To revert, start from a clean, up-to-date `main` (Fly Part 7, steps 1 and 2).

8. Find the bad commit's ID.

   ```bash
   git log --oneline -5
   ```

   You should see the last five commits, each starting with a short ID.

9. Undo the commit without opening an editor.

   ```bash
   git revert --no-edit <commit ID>
   ```

10. Push the undo.

    ```bash
    git push
    ```

    You should see CI start on GitHub. When it passes, the Deploy workflow ships the reverted code.

11. Or, instead of steps 8 to 10, pause the Deploy workflow.

    ```bash
    gh workflow disable Deploy --repo gobizhelp/handsfreeos
    ```

12. If you paused it, turn the workflow back on once the fix is on `main`.

    ```bash
    gh workflow enable Deploy --repo gobizhelp/handsfreeos
    ```

What a rollback does not undo:

- The current `fly.toml`, `[env]` values and secrets stay as they are.
- Database migrations stay applied.
- Fly does not keep old images forever, so roll back soon.

### Scaling and the always-on worker

- **The worker never stops.** Its `fly.toml` sets `auto_stop_machines = "off"`, so Fly never stops its machines. The `min_machines_running = 1` line in that file does nothing, because the setting only applies when machines are allowed to stop.
- **The API keeps one machine warm.** `auto_stop_machines = "stop"` with `min_machines_running = 1` keeps one machine running. Other machines stop when idle and start when traffic arrives.
- **Stops are graceful.** On a deploy or restart, Fly gives the worker up to 30 seconds to stop. It stops listening, then finishes its current pass. The API gets 15 seconds.

To see every machine:

```bash
fly machines list --app handsfreeos-worker
```

#### One worker machine or two

- **One** (what Fly Part 7 set up). Pro: about $4 a month cheaper, and 7 database connections. Con: if that machine fails, webhooks wait until it is back.
- **Two.** Pro: webhooks keep being answered if one machine fails. Con: about $4 a month more, and 14 database connections.

Running two is safe. Each loop locks the rows it claims, and the other machine skips locked rows. The recurring cleanup job is kept to one copy. Rows held by a machine that died are picked up again after 5 minutes. Before you add a machine to either app, check the database pool size (see "How many connections the apps use" in "The database: Supabase (hosted)").

To run two worker machines:

```bash
fly scale count 2 --app handsfreeos-worker
```

Fly shows what it will change and asks you to confirm. Type `y` and press Return. Then check:

```bash
fly status --app handsfreeos-worker
```

You should see two machines in the `started` state.

To go back to one:

```bash
fly scale count 1 --app handsfreeos-worker
```

Confirm the same way, then run `fly status --app handsfreeos-worker` again. You should see one machine.

#### Memory

Each app has 512 MB, set under `[[vm]]` in its `fly.toml`. To change it, edit `memory` there, commit, and deploy. Change the file rather than running a one-off command, because each deploy applies what the file says.

### Rotating secrets

How changes reach the apps:

- A secrets change restarts every machine of that app. Change several secrets in one import. Or stage each change with `--stage`, then apply them together, which needs no rebuild:

  ```bash
  fly secrets deploy --app handsfreeos-api
  ```

  ```bash
  fly secrets deploy --app handsfreeos-worker
  ```

- A command like `fly secrets set --app handsfreeos-worker NAME='<new value>'` saves the value in your Terminal history (`~/.zsh_history`). `fly secrets import` does not. Start it for the app you are changing, paste `NAME=value` lines without quotes, then press Return and Control-D:

  ```bash
  fly secrets import --app handsfreeos-api
  ```

  ```bash
  fly secrets import --app handsfreeos-worker
  ```

- `fly secrets list` shows a digest, not the value. After a change, the digest and date change.
- Update your password manager first, then Fly.

The console steps below describe the goal. If a console has moved or works differently, search it for the name in the middle column.

| Secret                                 | Where the new value comes from                     | How to switch without breaking things                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_URL_WORKER`  | A new password from `openssl rand -hex 32`         | See "Change an app role password" in "The database: Supabase (hosted)".                                                                                                                                                                                                            |
| `SUPABASE_SECRET_KEY`                  | The Supabase dashboard's **API Keys** page         | Create a new secret key, check it with steps 5 to 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6, set it on the worker, then delete the old key in the dashboard (see "Copy the publishable key and the secret key" in "The database: Supabase (hosted)").    |
| `POSTMARK_SERVER_TOKEN` and `SMTP_URL` | Postmark, the production server's **API Tokens**   | Check the new token with steps 1, 2 and 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6. Both contain the server token, so change them in one import. Then remove the old token in Postmark. See "Changing a token" under "Good to know" in "Email: Postmark". |
| `POSTMARK_ACCOUNT_TOKEN`               | Postmark, the account's **API Tokens**             | Check the new token with steps 3, 4 and 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6. Set it, then remove the old one in Postmark.                                                                                                                          |
| `POSTMARK_WEBHOOK_PASSWORD`            | `openssl rand -hex 24`                             | Follow "Changing the Postmark webhook password" below. A mismatch loses mail.                                                                                                                                                                                                      |
| `TWILIO_AUTH_TOKEN`                    | The Twilio console, master account, **Auth Token** | See "Rotate the master Auth Token later" in "The phone carrier: Twilio". Subaccount tokens are separate and do not change.                                                                                                                                                         |
| `MICROSOFT_OAUTH_CLIENT_SECRET`        | The Entra app, **Certificates & secrets**          | See "Rotating the client secrets" in "Connected mailboxes: Outlook and Gmail". Put the new expiry date in your calendar.                                                                                                                                                           |
| `GOOGLE_OAUTH_CLIENT_SECRET`           | The Google Cloud OAuth client                      | See "Rotating the client secrets" in "Connected mailboxes: Outlook and Gmail".                                                                                                                                                                                                     |
| `FLY_API_TOKEN`                        | `fly tokens create org` (Fly Part 9)               | Store the new token in GitHub, then find the old token's ID and revoke it (end of Fly Part 9).                                                                                                                                                                                     |
| `WORKER_ENCRYPTION_KEY`                | `openssl rand -base64 32`                          | See "Rotating the worker encryption key" below.                                                                                                                                                                                                                                    |

#### Changing the Postmark webhook password

There is a gap between the worker restarting and Postmark saving the new addresses. During that gap, Postmark's calls get a 403, and Postmark does not retry them. Replies are lost, and so are delivery, bounce and spam events. So do this at a quiet time, and quickly.

1. Generate the new password.

   ```bash
   openssl rand -hex 24
   ```

2. Save it in your password manager in the "Postmark webhook password" entry.

3. Start a staged import. It does not restart the worker.

   ```bash
   fly secrets import --stage --app handsfreeos-worker
   ```

4. Paste `POSTMARK_WEBHOOK_PASSWORD=<new webhook password>` without quotes. Press Return, then Control-D.

   You should see the import finish without an error.

5. In Postmark, open the settings for the inbound stream's webhook and the outbound webhook, ready to paste the new addresses. (The addresses are in Postmark Parts G and H.)

6. Apply the staged password. The worker restarts.

   ```bash
   fly secrets deploy --app handsfreeos-worker
   ```

7. Right away, save both webhooks in Postmark with the new password in their addresses.

8. Check the inbound stream's activity in Postmark for messages that failed during the switch. "Postmark webhooks are rejected" in "Going live, and when something goes wrong" shows how to retry them.

9. Send a test email to a workspace's address on `mail.handsfreeos.com`.

   You should see it arrive in that workspace's **Inbox**.

10. Check the worker's log.

    ```bash
    fly logs --app handsfreeos-worker --no-tail
    ```

    You should see no `rejected an inbound mail webhook without the right credentials` line after the switch.

### Rotating the worker encryption key

How it works: the worker seals new values with `WORKER_ENCRYPTION_KEY`. Each sealed value records an 8-character key ID for the key that sealed it. To open a value, the worker uses the matching key: the current one, or any key in `WORKER_ENCRYPTION_KEYS_PREVIOUS`.

**There is no re-seal script.** Nothing rewrites stored values with the new key. So:

- **Twilio credentials are never sealed again.** Each subaccount's auth token and browser-call key stay sealed with the key that was current when that business got its phone number. The old key must stay in `WORKER_ENCRYPTION_KEYS_PREVIOUS` for as long as any of those businesses exist. Removing it breaks their texts, calls and browser calls. Twilio's requests get 500 errors, and the log shows `No key <id> to open this value. Add the old key to WORKER_ENCRYPTION_KEYS_PREVIOUS.`
- **Mailbox sign-ins re-seal themselves** with the new key each time their access is refreshed. For a mailbox in use, that is about once an hour.
- **A rotation does not protect values that are already sealed.** If the old key leaked, anyone holding it can still open everything it sealed. Recovering from that would mean new Twilio credentials for every business, and HandsFreeOS has no tool for that yet. Guard this key closely.

Rotate only when you have a reason. To rotate:

1. Generate the new key.

   ```bash
   openssl rand -base64 32
   ```

2. Save it in your password manager as "Worker encryption key (current)". Relabel the old entry "Worker encryption key (previous, retired <date>)". Never delete an old key entry.

3. Start an import that applies right away. It has no `--stage`, so the worker restarts.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

4. Paste these two lines without quotes, then press Return and Control-D. If `WORKER_ENCRYPTION_KEYS_PREVIOUS` already holds keys, keep them all, separated by commas: `<old encryption key>,<older encryption key>`.

   ```text
   WORKER_ENCRYPTION_KEY=<new encryption key>
   WORKER_ENCRYPTION_KEYS_PREVIOUS=<old encryption key>
   ```

5. Check that the worker restarted cleanly.

   ```bash
   fly logs --app handsfreeos-worker --no-tail
   ```

   You should see `worker started`. If you see `WORKER_ENCRYPTION_KEY must be 32 random bytes, base64 encoded`, one of the keys, new or previous, was pasted wrong.

#### Checking which keys still seal stored values

1. Copy a key from your password manager.
2. Get its key ID.

   ```bash
   pbpaste | openssl base64 -d -A | openssl dgst -sha256 -r | cut -c1-8
   ```

   You should see 8 letters and digits.

3. Clear the clipboard.

   ```bash
   pbcopy < /dev/null
   ```

4. Write the ID next to that key in your password manager. Repeat steps 1 to 4 for each key.

5. In the Supabase dashboard's **SQL Editor**, run this query for phone credentials:

   ```sql
   select split_part(auth_token_enc, '.', 2) as auth_token_key,
          split_part(api_key_secret_enc, '.', 2) as call_key_key,
          count(*)
   from app.telephony_accounts
   group by 1, 2;
   ```

   You should see key IDs, each with a count. The query shows only key IDs, never the credentials.

6. Run this query for mailbox sign-ins:

   ```sql
   select split_part(token_enc, '.', 2) as mailbox_key, count(*)
   from app.mailbox_connections
   where token_enc is not null
   group by 1;
   ```

   You should see key IDs, each with a count.

7. Remove a key from `WORKER_ENCRYPTION_KEYS_PREVIOUS` only when neither query shows its ID. Phone credentials never change, so in practice keep every old key.

### Rough monthly cost

Fly sends each organization one bill a month. Running machines are billed by the second. Prices come from Fly's pricing pages in September 2026.

| Item                                                        | About per month                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| API machine, always running (`shared-cpu-1x`, 512 MB)       | $3.99 in `dfw`, $3.19 in `iad`                                       |
| Worker machine, always running                              | $3.99 in `dfw`, $3.19 in `iad`                                       |
| Second API machine from the first deploy, stopped when idle | A few cents. Stopped machines pay only for storage, at $0.15 per GB. |
| Second worker machine, only if you run two                  | $3.99 in `dfw`, $3.19 in `iad`                                       |
| Two certificates                                            | Free (the first 10 per organization are free)                        |
| Shared IPv4 and IPv6 addresses                              | Free                                                                 |
| Dedicated IPv4 address                                      | $2 per app. Not needed.                                              |
| Outbound traffic                                            | $0.02 per GB in North America. Inbound traffic is free.              |

Total for Fly in `dfw`: about $8 a month with one worker machine, or about $12 with two. In `iad`, about $6.40 or $9.60.

Other bills:

- Supabase bills separately. The Go Biz Help organization is on the Pro plan, from $25 a month for the whole organization. This project's compute comes on top: when the project was created, Supabase quoted about $10 a month for its Micro size.
- Twilio, Postmark and Vercel also bill separately (see "Before you start" at the top of this guide).
- Fly's pricing page lists no charge for its builders as of September 2026. Check your first invoice for any line you do not expect.

## The web app on Vercel

The web app (`apps/web`, a Next.js app) runs on Vercel at `https://app.handsfreeos.com`. Vercel builds it from GitHub by itself: every push to `main` goes live, and every other branch gets a preview. The web app holds no secrets. Every value it needs is public and ends up in the browser, so the Vercel project gets seven plain settings and nothing else.

Set up the API (`handsfreeos-api`) and the worker (`handsfreeos-worker`) on Fly.io first (see "Hosting: the API and the worker on Fly.io"). The web app is only useful once both answer.

Vercel and Supabase rename menus from time to time. If a menu below has moved, search the console, or Vercel's documentation, for the setting's name.

### Before you start

1. Check that the API answers.

   ```bash
   curl https://api.handsfreeos.com/healthz
   ```

   You should see a reply that starts with `{"ok":true`.

2. Check that the worker answers.

   ```bash
   curl https://hooks.handsfreeos.com/healthz
   ```

   You should see `{"ok":true}`.

3. Have the Supabase publishable key (it starts with `sb_publishable_`) in your password manager as "Supabase publishable key". If it is not there yet, copy it with steps 1 to 6 of "Copy the publishable key and the secret key" in "The database: Supabase (hosted)". Never use a key that starts with `sb_secret_` for the web app. That key belongs to the worker only.

### Vercel account and Pro team

Vercel's free Hobby plan is for personal, non-commercial use only, so HandsFreeOS needs a Pro team. At the time of writing, Pro costs $20 a month. That includes one seat that can deploy and $20 of usage credit each month. Usage beyond the credit is billed on top. Vercel notifies you when you reach 75% of the credit, and by default it also sends a spend notification at $200 in a billing cycle. Each extra seat that can deploy (Owner or Member) costs $20 a month. Viewer seats are free. Pro starts with a 14-day trial, and each Vercel account gets one trial.

1. Go to `https://vercel.com/signup` and sign up with GitHub, using the GitHub account `gobizhelp`. If you already have a Vercel account, log in with GitHub instead.
2. Open the team switcher at the top left.
3. Click **Create Team** at the bottom of the list.
4. Name the team, for example `Go Biz Help`.
5. Choose **Pro Trial**.

   If **Pro Trial** does not appear, this Vercel account has already used its one trial. Create the team anyway. The payment method you add in steps 7 and 8 puts it on Pro.

6. Click the button that creates the team.

   You should see the new team selected in the team switcher.

7. With the new team selected, click **Settings**, then **Billing**.
8. Add a payment method.

   You should see the payment method on the **Billing** page.

The trial ends after 14 days, or sooner if the team reaches the trial's usage limits. With a payment method on file, billing starts when the trial ends. Without one, the team drops back to Hobby and every member except the owner (you) is removed.

### Create the project

`gobizhelp` is a personal GitHub account, not a GitHub organization. Vercel's rule that every commit author must be a member of the Pro team applies only to private repositories owned by an organization, so it does not affect `gobizhelp/handsfreeos`. If the repository ever moves to a GitHub organization, each person who commits needs a Vercel account, linked to GitHub, that is a member of the Pro team. Otherwise their deployments fail with "Team access required to deploy." If the team uses **Manual Approval**, approve new members under the team's **Settings** → **Members**.

1. Make sure the Pro team is selected in the team switcher at the top left.
2. Click **Add New…** and choose **Project**.
3. Under **Import Git Repository**, click **Import** next to `gobizhelp/handsfreeos`.

   If `gobizhelp/handsfreeos` is not listed:

   1. Look below the list for a link to install or adjust the Vercel GitHub App, and click it. If there is none, open `https://github.com/settings/installations` while signed in to GitHub as `gobizhelp`.
   2. Click **Configure** next to **Vercel**.
   3. Under **Repository access**, choose **Only select repositories**.
   4. Add `handsfreeos` to the list.
   5. Click **Save**.
   6. Go back to Vercel and refresh the page.

      You should see `gobizhelp/handsfreeos` with an **Import** button.

4. Set **Project Name** to `handsfreeos-web`.
5. Next to **Root Directory**, click **Edit**.
6. In the window that opens, click `apps`, then `web`.
7. Click the button at the bottom of the window that confirms the choice.

   You should see **Root Directory** show `apps/web`.

8. Check that **Framework Preset** shows **Next.js**. If it does not, pick **Next.js** from the list.
9. Open **Build and Output Settings** and leave every **Override** switch off. Vercel then builds only the web app. It installs with pnpm because it finds `pnpm-lock.yaml` at the top of the repository.
10. Open **Environment Variables**. In the block below, replace `<publishable key>` with the key from your password manager. Then paste the whole block into the first **Name** (or **Key**) field. Vercel splits a pasted `.env` block into separate variables. If the form does not split it, add the seven lines one at a time as name and value. If the form lets you choose a type for each variable, choose **Config** for all seven.

    ```text
    NEXT_PUBLIC_API_URL=https://api.handsfreeos.com
    NEXT_PUBLIC_WORKER_URL=https://hooks.handsfreeos.com
    NEXT_PUBLIC_SUPABASE_URL=https://ybupfghakoszfcxhyrby.supabase.co
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
    NEXT_PUBLIC_PASSKEYS_ENABLED=true
    NEXT_PUBLIC_GMAIL_ENABLED=false
    ENABLE_EXPERIMENTAL_COREPACK=1
    ```

    Add them before the first build. Next.js copies these values into the app while it builds. A build without them points at the wrong addresses or stops. What each one does is in "Environment variables" below.

11. Click **Deploy**.

    You should see the build log scroll by, and the deployment end as **Ready** after a few minutes. If the build fails with "is not set (run `pnpm env:local`)", a variable is missing. Add it and redeploy. Never run `pnpm env:local` for the hosted stack.

12. On the deployment page, open the build log and search it for `pnpm` (press Command-F).

    You should see `12.3.4` near the install step. If the log names pnpm 9 or 10 instead, the pinned version was not used: follow "If the build fails" below even though the build finished. Do the same if the install failed.

13. Click **Settings**, then **Environment Variables**.

    You should see all seven names, and each value can be shown. If a value cannot be shown, it was saved as **Secret**. Delete it, add it again as **Config** (see "Environment variables" below), and redeploy.

14. Open the `.vercel.app` address Vercel shows for the deployment. Vercel may ask you to sign in to Vercel first.

    You should see the HandsFreeOS sign-in page with the heading "Welcome back". Do not use the app at this address. The API and the worker only accept requests from `https://app.handsfreeos.com`, so saving anything fails here. That is expected.

### Build settings to check once

Open the project, click **Settings**, then **Build and Deployment**. Older Vercel pages call parts of this page **Build & Development Settings**.

1. Under **Node.js Version**, choose `22.x`. New projects start on 24.x. Version 22 matches `.nvmrc`, CI and the Fly.io images. Do not choose 20.x: Vercel stops building on Node 20 from 1 October 2026.
2. Click **Save** in that section.
3. Under **Root Directory**, check that the path is `apps/web`. If it is not, enter `apps/web`.
4. In the same section, find **Include source files outside of the Root Directory in the Build Step**. If it is off, turn it on. The web app uses shared code from `packages/core` and `packages/api-client`, and the build cannot see those folders without it. New projects have it on.
5. In the same section, make sure **Skip deployment** is on. If it is off, turn it on. A push that only changes the API or the worker then does not rebuild the web app.
6. If you changed anything in the **Root Directory** section, click **Save** in that section.
7. Under **Framework Settings**, check that **Framework Preset** is **Next.js** and that every **Override** switch is off, unless you used a fallback from "If the build fails".
8. Click **Settings** → **Deployment Protection** and check that **Vercel Authentication** is on with **Standard Protection**. It keeps `https://app.handsfreeos.com` public and asks for a Vercel login on preview addresses. Do not choose **All Deployments**: it would put a Vercel login in front of every client.
9. Redeploy so the new Node.js version takes effect (see "Redeploy after a change").

   You should see the new deployment reach **Ready**.

10. Open the new deployment's build log and search it for `engines`.

    You should see no warning that says the **Node.js Version** from your Project Settings will not apply. If there is one, Vercel is building on Node.js 24 because of the `engines` range `>=22.12` in the root `package.json`. Vercel's documentation does not say which `package.json` it reads in a monorepo, so this needs checking once. To keep Node.js 22, the repository needs a small code change: `"engines": { "node": "22.x" }` in `apps/web/package.json`, or the root range narrowed to `22.x`.

Vercel treats `main` as the production branch by default. Leave it.

#### If the build fails

Vercel's documentation lists pnpm only up to version 10. HandsFreeOS pins pnpm 12.3.4 in the root `package.json` (the `packageManager` field). `ENABLE_EXPERIMENTAL_COREPACK=1` is Vercel's documented switch for using that pinned version, and Vercel's documentation says the field belongs in the `package.json` at the root of the repository, which is where it is. This had not been tried on Vercel with the Root Directory set to `apps/web` when this guide was written. Follow these steps if the build log shows a pnpm or Corepack error during the install, or names a pnpm version other than 12.3.4:

1. Click **Settings** → **Environment Variables**.
2. Click the three dots to the right of `ENABLE_EXPERIMENTAL_COREPACK` and choose **Delete**.
3. Click **Settings** → **Build and Deployment** → **Framework Settings**.
4. Turn on **Override** next to **Install Command**.
5. Paste this into the **Install Command** field. It is for Vercel, not for your Mac terminal. It installs pnpm the same way the Fly.io images do.

   ```text
   npm install -g pnpm@12.3.4 && pnpm install --frozen-lockfile
   ```

6. Click **Save**.
7. Redeploy with **Use existing Build Cache** unticked.
8. Open the new build log and search it for `pnpm`.

   You should see `12.3.4` near the install step, and the deployment reach **Ready**.

   If the log still names another pnpm version, replace the **Install Command** with the line below, click **Save**, and redeploy again. This one is untested too.

   ```text
   npx pnpm@12.3.4 install --frozen-lockfile
   ```

Never set the install command to plain `pnpm install`. Vercel then uses the oldest pnpm it has, pnpm 6.

Two other build problems have their own fix: the build log says `turbo` cannot be found (for example `turbo: command not found`), or it shows `@hfos/api` or `@hfos/worker` being built. For either one:

1. Click **Settings** → **Build and Deployment** → **Framework Settings**.
2. Turn on **Override** next to **Build Command**.
3. Paste this into the **Build Command** field, not into your terminal. It is the command CI uses.

   ```text
   cd ../.. && pnpm --filter @hfos/web build
   ```

4. Click **Save**, then redeploy.

Never use the root `pnpm build` as the build command. It builds the API and the worker as well.

### Environment variables

The web app reads six settings, and Vercel reads one more for the install. All seven are plain, public values. Next.js copies the `NEXT_PUBLIC_` ones into the pages, so anyone can read them in a browser. That is why none of them may ever be a secret.

| Name                                   | Value                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`                  | `https://api.handsfreeos.com`              | The API on Fly.io. Without it the app calls `http://127.0.0.1:4000` and no page loads.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `NEXT_PUBLIC_WORKER_URL`               | `https://hooks.handsfreeos.com`            | The worker: number search, browser calls, **Connect Outlook** and **Connect Gmail**. Must match `WORKER_PUBLIC_URL` in `apps/worker/fly.toml`. Without it, those features point at `http://127.0.0.1:4100`, and number search and calls show "The phone service is not reachable right now. Try again in a minute."                                                                                                                                                                                   |
| `NEXT_PUBLIC_SUPABASE_URL`             | `https://ybupfghakoszfcxhyrby.supabase.co` | The hosted Supabase project. Required: without it the build or the first page fails, usually with an error that starts `NEXT_PUBLIC_SUPABASE_URL is not set`. The message goes on to say to run `pnpm env:local`, but that only applies on your laptop. On Vercel, add the variable in **Settings** → **Environment Variables** and redeploy. An error saying the project's URL and Key are required to create a Supabase client means the same thing. Look for either in the deployment's build log. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `<publishable key>`                        | Copied from Supabase **Project Settings** → **API Keys** and kept in your password manager. Starts with `sb_publishable_`. Required, like the URL, and fails the same way without it.                                                                                                                                                                                                                                                                                                                 |
| `NEXT_PUBLIC_PASSKEYS_ENABLED`         | `true`                                     | Shows passkey sign-in and the passkey settings. Only the exact value `false` turns them off.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXT_PUBLIC_GMAIL_ENABLED`            | `false`                                    | Keeps **Connect Gmail** off until Google approves the restricted scopes. Only the exact value `true`, in lower case, turns it on; `True`, `1` or `yes` leave Gmail off. Leaving it unset also keeps Gmail off.                                                                                                                                                                                                                                                                                        |
| `ENABLE_EXPERIMENTAL_COREPACK`         | `1`                                        | Read by Vercel, not by the app. Makes the install use pnpm 12.3.4, the version pinned in the root `package.json` (the `packageManager` field). If the build log names another pnpm version, use "If the build fails".                                                                                                                                                                                                                                                                                 |

To add or change a variable after the import:

1. Open the project, click **Settings**, then **Environment Variables**.
2. If the variable is already listed, click the three dots to the right of its name and choose **Edit**, then go on at step 4.
3. Enter the **Name** (Vercel may label it **Key**).
4. Enter the **Value**, exactly as this guide gives it, in the same case.
5. Tick **Production** and **Preview**. Leave **Development** unticked: on your laptop the web app uses `apps/web/.env.local`, which `pnpm env:local` writes with local addresses. If a variable added on the import screen also lists **Development**, that is harmless.
6. Choose the type **Config**. A **Secret** value can never be read back after saving, and nothing here is secret.
7. Click **Save**.

   You should see the variable in the list, with **Production** and **Preview** named next to it.

8. Redeploy (see "Redeploy after a change"). Until you do, the site keeps the old value.

To delete a variable, click the three dots to the right of its name and choose **Delete**.

Never add any of the following to Vercel. They live only in Fly.io secrets (the worker's, plus `DATABASE_URL` in the API's) and in your password manager. CI checks the browser files of its own web build for a real Supabase secret key and a few provider secret names. It does not check for database addresses or `SMTP_URL`, it does not check the server code, and it cannot see what you type into Vercel. So this rule depends on you. Before you save a Vercel variable, check that it is one of the seven above.

- a Supabase key that starts with `sb_secret_`, or `SUPABASE_SECRET_KEY`
- `DATABASE_URL`, `DATABASE_URL_WORKER` or any other database connection string
- anything that starts with `TWILIO_`, `POSTMARK_`, `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_`
- `WORKER_ENCRYPTION_KEY` or `SMTP_URL`

Do not paste or upload `.env.hosted` or any other `.env` file from your laptop into Vercel. `.env.hosted` also holds the database passwords. Copy only the publishable key. In Vercel its name must be exactly `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

### Redeploy after a change

Next.js writes the `NEXT_PUBLIC_` values into the app while it builds. That covers the code sent to browsers and also the code that runs on Vercel's servers, such as the sign-in check on every page. After the build, a deployment keeps those values whatever the settings say, and Vercel applies changed settings only to new deployments. So every change to a web setting needs a new build. The same goes for the Node.js version and the root directory.

1. Open the project and click **Deployments**.
2. Find the newest deployment marked **Production**. Use the environment filter if previews crowd the list.
3. Click the three dots (**…**) on its row and choose **Redeploy**.
4. In the **Redeploy to Production** window, untick **Use existing Build Cache**.
5. Click **Redeploy**.

   You should see a new deployment start and reach **Ready** after a few minutes.

6. Reload `https://app.handsfreeos.com` and check the change. For example, after you set `NEXT_PUBLIC_GMAIL_ENABLED` to `true`, **Settings** → **Email** shows **Connect Gmail** ready to use instead of waiting on Google.

A push to `main` also builds with the current settings.

### Add app.handsfreeos.com

1. In the project, click **Settings**, then **Domains**.
2. Click **Add Domain**.
3. Type `app.handsfreeos.com` in the domain field and click the button next to it that adds the domain. If Vercel asks, connect it to **Production** rather than setting up a redirect.

   You should see a card for `app.handsfreeos.com` marked **Invalid Configuration**, showing the DNS record Vercel wants.

4. Note the record on the card. For `app` it is a **CNAME** with the name `app` and a target made for this project (it looks like `<letters and numbers>.vercel-dns-<number>.com`). Copy the target exactly as shown.
5. If the card also asks for a **TXT** record, note that too. Vercel asks for one when `handsfreeos.com` is already in use on another Vercel account.
6. On your Mac, find out who runs DNS for `handsfreeos.com`.

   ```bash
   dig ns handsfreeos.com +short
   ```

   You should see two or more name server names. They show your DNS provider. Today they end in `ns.cloudflare.com`, which means Cloudflare.

7. Sign in to that provider and open the DNS records for `handsfreeos.com`.
8. Delete any existing A, AAAA or CNAME record named `app`.
9. Add a CNAME record: name `app`, target from the card, TTL automatic (or 60 seconds). On Cloudflare, set the proxy switch to **DNS only** (grey cloud) before you save the record, so Vercel can issue the certificate.
10. If the card asked for a TXT record, add it with the name and value shown.
11. Leave the `api`, `hooks` and Postmark records as they are, and do not add an AAAA record for `app`.
12. On your Mac, check the record.

    ```bash
    dig cname app.handsfreeos.com +short
    ```

    You should see the target from the card. A new record usually shows up within minutes, sometimes after a few hours.

13. Vercel's certificate also comes from Let's Encrypt. If `handsfreeos.com` has CAA records, you already allowed `letsencrypt.org` in steps 3 to 5 of Fly Part 8. If you skipped those steps, do them now.
14. Go back to **Settings** → **Domains** in Vercel and wait.

    You should see the card change to **Valid Configuration**. Vercel then issues the certificate by itself, usually within minutes.

15. Open `https://app.handsfreeos.com`. Always use this address: the API and the worker only accept browsers on `https://app.handsfreeos.com`, so a `vercel.app` preview address or `www.` breaks them.

    You should see the sign-in page ("Welcome back", "Sign in to your workspaces.") over HTTPS, with no certificate warning.

16. Sign in with the email and password you use for HandsFreeOS. If you have never signed up on `https://app.handsfreeos.com`, create an account first with "Create your first account" in "The database: Supabase (hosted)". Until Auth email goes through Postmark, sign up with the address you use to sign in to Supabase: Supabase's built-in sender only reaches members of the Supabase organization's team, at most 2 an hour.

    You should see HandsFreeOS: your workspace, or the screen that sets up a new one.

17. In a workspace, click **Tasks** in the left menu.
18. Click **New task**.
19. Type a title, for example `Vercel check`.
20. Click **Add task**. The browser sends this straight to the API, so it proves the API accepts the web address.

    You should see the new task in the list. If saving fails, run the two `access-control-allow-origin` checks in steps 11 and 12 of "Change the API and worker settings".

### Keep the web address the same everywhere

`https://app.handsfreeos.com` is written in several places besides Vercel. They must all match exactly: `https://`, the host name, and nothing after it. The API and the worker compare the browser's address letter for letter, so `https://app.handsfreeos.com/` with a trailing slash never matches.

| Where                                                                                                                              | Setting                           | Value                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Vercel, **Settings** → **Domains**                                                                                                 | the production domain             | `app.handsfreeos.com`                                                                      |
| `apps/api/fly.toml`, under `[env]`                                                                                                 | `WEB_ORIGINS`                     | `https://app.handsfreeos.com`                                                              |
| `apps/worker/fly.toml`, under `[env]`                                                                                              | `WEB_ORIGINS`                     | `https://app.handsfreeos.com`                                                              |
| `apps/worker/fly.toml`, under `[env]`                                                                                              | `WEB_URL`                         | `https://app.handsfreeos.com`                                                              |
| Supabase, **Authentication** → **URL Configuration**                                                                               | **Site URL**                      | `https://app.handsfreeos.com`                                                              |
| Supabase, **Authentication** → **URL Configuration**                                                                               | **Redirect URLs**                 | `https://app.handsfreeos.com/auth/callback` and `https://app.handsfreeos.com/auth/confirm` |
| Supabase, **Authentication** → **Passkeys**                                                                                        | **Relying Party ID**              | `handsfreeos.com`                                                                          |
| Supabase, **Authentication** → **Passkeys**                                                                                        | **Relying Party Origins**         | `https://app.handsfreeos.com`                                                              |
| Google Cloud, the OAuth client for Google sign-in (see "Sign in with Google" in "The database: Supabase (hosted)"), once it exists | **Authorized JavaScript origins** | `https://app.handsfreeos.com`                                                              |

What each one controls:

- **API `WEB_ORIGINS`**: the web addresses allowed to call the API from a browser. List several with commas between them.
- **Worker `WEB_ORIGINS`**: the same, for number search and call tokens.
- **Worker `WEB_URL`**: the start of every link the worker emails (invitations, unanswered-message reminders, mailbox and texting emails). It is also the page that **Connect Outlook** and **Connect Gmail** return to. A wrong value breaks all of them.
- **Supabase Site URL**: where confirmation, password-reset and email-change links point. The templates in `supabase/templates` build their links from it.
- **Supabase Redirect URLs**: extra addresses Supabase may send people back to after Google sign-in and email links. Addresses on `https://app.handsfreeos.com` are always allowed, because that is the Site URL. The list matters for any other address, such as a preview.
- **Passkeys**: a passkey works only on its Relying Party ID domain and from the listed origins. Keep the web app under `handsfreeos.com`. Changing the Relying Party ID makes every passkey already registered stop working.
- **Google sign-in client**: the Google OAuth client whose client ID is entered in Supabase under **Authentication** → **Sign In / Providers** → **Google**. It is a different client from the worker's Gmail client, whose redirect URI is on `hooks.handsfreeos.com`. In Google Cloud it is listed under **Google Auth Platform** → **Clients** (older menus: **APIs & Services** → **Credentials**). Besides the JavaScript origin above, its **Authorized redirect URIs** must hold the callback address Supabase shows on its Google provider page: `https://ybupfghakoszfcxhyrby.supabase.co/auth/v1/callback`.

It matters the other way too: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WORKER_URL` in Vercel must match the API's and the worker's addresses.

#### Change the API and worker settings

These are plain settings in files in the repository, not Fly.io secrets, so `fly secrets set` does not change them.

1. Open Terminal and get the latest code.

   ```bash
   cd ~/Projects/HandsFreeOS && git switch main && git pull
   ```

2. Open `apps/api/fly.toml` in a text editor.
3. Under `[env]`, change the value of `WEB_ORIGINS`. Keep the straight double quotes around it.
4. Save the file.
5. Open `apps/worker/fly.toml` in a text editor.
6. Under `[env]`, change the values of `WEB_ORIGINS` and `WEB_URL`.
7. Save the file.
8. Commit the change and push it to GitHub.

   ```bash
   git add apps/api/fly.toml apps/worker/fly.toml && git commit -m "Change the web address" && git push
   ```

   You should see a new **CI** run for your commit at `https://github.com/gobizhelp/handsfreeos/actions`.

9. Wait until the **CI** run shows a green check, and then the **Deploy** run that follows it. The Deploy workflow ships the worker and then the API. To run it by hand, open the repository on GitHub and click **Actions** → **Deploy** → **Run workflow**.
10. Run the two `curl .../healthz` commands from "Before you start" in this section.

    You should see the API reply start with `{"ok":true` and the worker reply `{"ok":true}`.

11. Check that the API accepts the web address.

    ```bash
    curl -s -o /dev/null -D - -H 'Origin: https://app.handsfreeos.com' https://api.handsfreeos.com/healthz | grep -i access-control-allow-origin
    ```

    You should see `access-control-allow-origin: https://app.handsfreeos.com`. If nothing prints, the API does not accept that address.

12. Check that the worker accepts it too.

    ```bash
    curl -s -o /dev/null -D - -H 'Origin: https://app.handsfreeos.com' https://hooks.handsfreeos.com/healthz | grep -i access-control-allow-origin
    ```

    You should see the same line.

#### Change the Supabase settings

1. Open the Supabase dashboard and pick the project **HandsFreeOS**.
2. Click **Authentication** → **URL Configuration**.
3. Set **Site URL** to the web address.
4. Click the save button for **Site URL**.

   You should see a confirmation message, and the value is still there after you reload the page.

5. Make sure **Redirect URLs** lists the web address followed by `/auth/callback` and the web address followed by `/auth/confirm`. If one is missing, add it and save.

   You should see both addresses in the list after you reload the page.

6. Click **Authentication** → **Passkeys**.
7. Keep **Relying Party ID** as `handsfreeos.com`, and make sure **Relying Party Origins** lists the web address.
8. Click the save button on that page.

   You should see a confirmation message, and the values are still there after you reload the page.

Change Supabase Auth settings in the dashboard only. Never run `supabase config push` against the hosted project (see "Push with the Supabase CLI" in "The database: Supabase (hosted)").

### Preview deployments

Every push to a branch other than `main` builds a preview at its own `.vercel.app` address, such as `handsfreeos-web-git-<branch>-<team>.vercel.app`. Previews use the **Preview** values of the settings. That means they talk to the real Supabase project, the real API and the real worker, with real data. Vercel Authentication asks for a Vercel login before anyone can open one.

What works on a preview:

- **Password sign-in works.** The browser talks straight to Supabase, and no redirect URL is involved. You sign in to the production project with your real account.
- **Pages load**, because Vercel's servers fetch their data from the API.

What does not work:

- **Anything the browser sends to the API or the worker fails**: saving, number search, calls, **Connect Outlook** and **Connect Gmail**. `WEB_ORIGINS` only takes exact addresses, not wildcards, and every preview has a new address.
- **Passkeys fail.** They are tied to `handsfreeos.com`, and `vercel.app` is a different domain.
- **Email links open production.** Sign-up confirmation and password-reset links always use the Supabase Site URL.
- **Google sign-in fails** unless Supabase's **Redirect URLs** include the preview address. Without it, Supabase sends you to `https://app.handsfreeos.com` instead of back to the preview. The sign-in does not finish, and you see the normal production sign-in page with no error message, or your production workspace if you were already signed in there. You are not signed in on the preview.

So use a preview to look at a page before it goes live, not to test anything that saves.

Recommended:

1. Leave **Standard Protection** on.
2. Do not add preview addresses to `WEB_ORIGINS` on the API or the worker.
3. Do not add a `vercel.app` pattern to Supabase's **Redirect URLs**. Supabase documents `https://*-<team-slug>.vercel.app/**` for Vercel previews, where `<team-slug>` is your Vercel team's short name. It would let Google sign-in return to a preview, but everything else above would still fail, so it is not worth widening the list.
4. Keep the Preview values of the settings while previews are on. Without the two Supabase settings, every preview build fails.

Optional: hide the passkey button on previews.

1. Click **Settings** → **Environment Variables**.
2. Click the three dots next to `NEXT_PUBLIC_PASSKEYS_ENABLED` and choose **Edit**.
3. Untick **Preview** and save.
4. Add `NEXT_PUBLIC_PASSKEYS_ENABLED` again with the value `false`, only **Preview** ticked, and the type **Config**.
5. Click **Save**.

Optional: stop building previews altogether.

1. Click **Settings** → **Build and Deployment**.
2. Under **Ignored Build Step**, choose **Only build production**.
3. Click **Save**.

Vercel still starts each skipped build and cancels it, and those count toward its deployment limits.

### Make Vercel wait for CI (optional)

By default, Vercel puts a new production build live as soon as it is ready, without waiting for CI. Vercel's Deployment Checks can hold it back until the CI jobs pass.

1. Open the project and click **Settings** → **Environments** → **Production**.
2. Check that automatic aliasing for production is on. It is the setting that gives each new production build `app.handsfreeos.com`, and Deployment Checks need it.
3. Click **Settings** → **Build and Deployment** and find **Deployment Checks**.
4. Click **Add Checks**.
5. Choose **GitHub** as the provider.
6. Search for and select the two CI jobs: **Lint, typecheck, tests, browser tests** and **Secret scan**.

   You should see both checks listed under **Deployment Checks**.

7. Push the next change to `main` as usual.

   You should see the new production deployment wait for the checks, and `https://app.handsfreeos.com` switch to it only after CI passes.

Production builds are still created, but they only get `app.handsfreeos.com` once the checks pass. In an emergency, open the deployment's page and choose **Force Promote** to put it live without waiting. GitHub identifies checks by job name, so if a CI job is ever renamed, update the checks here too.

### Good to know

- **Vercel does not wait for CI by default.** A push to `main` goes live on Vercel within minutes, while the API and the worker wait for CI to pass. A web change that needs a new API can reach clients a few minutes before the API does. A web change that fails CI is live anyway, unless you set up "Make Vercel wait for CI" above.
- **Rolling back.** On the project's overview page, click **Instant Rollback** on the production deployment tile. Pick an earlier deployment, click **Continue**, then **Confirm Rollback**. The earlier deployment comes back with the settings it was built with. After a rollback, new pushes to `main` stop going live. To undo it, click **Undo Rollback** on the same tile, pick the deployment to put live (usually the newest good one), and click **Confirm**. New pushes to `main` then go live again.
- **Calls need HTTPS.** Browsers only allow the microphone on HTTPS pages. Vercel serves HTTPS, so calls work at `https://app.handsfreeos.com`.
- **New web settings.** The build may run through Turborepo, which hides every setting not listed for builds in `turbo.json`. That file already lists `NEXT_PUBLIC_*`. A future web setting with any other name must be added there too.
- **Your laptop is separate.** `pnpm env:local` writes local addresses into `apps/web/.env.local` for `pnpm dev`. Never copy that file into Vercel.

## The phone carrier: Twilio

HandsFreeOS has one Twilio account, the master account. When a client business buys its first number in HandsFreeOS, the worker creates a Twilio subaccount for that business and buys the number inside it, along with everything else the business needs. You set up the master account once. There is nothing to set up per client in the Twilio console.

Only the worker (`handsfreeos-worker`) talks to Twilio. It calls Twilio's API over HTTPS with an account SID and token, without a Twilio SDK. The API (`handsfreeos-api`) must never hold a Twilio value: it refuses to start if any environment variable name starts with `TWILIO_`.

Twilio has two consoles at the moment. The new Twilio Console became generally available on May 5, 2026, and accounts move to it through a banner or a wizard. Many of Twilio's help pages still describe the legacy console. Where the two differ, the steps below give both. If you're not sure which console you have, try the first path given. If its first menu name isn't on your screen, use the other path. If a menu has moved in either console, type the page name from the step into the search bar at the top of the console.

### Before you start

Have these ready:

- A Twilio account. If you don't have one yet, sign up at `https://www.twilio.com/try-twilio` with the business email address.
- The Owner or Admin role in that Twilio account. Trust Hub, geo permissions and auth tokens need one of them.
- The details of the legal company that owns HandsFreeOS. If HandsFreeOS isn't its own company, this is the company behind Go Biz Help. Every business detail below is that company's.
- That company's IRS EIN letter (CP 575 or 147C). Twilio compares the legal name with it exactly.
- The company's street address and a business email address (not a throwaway one).
- A working website for the company, for example `https://handsfreeos.com`. It must load and name the legal company, for example in the footer.
- A government photo ID. Twilio's ID checker may also ask for a selfie.
- A card or a PayPal account.
- The Fly command line (`fly`), installed on your Mac and signed in (see "Before you start" at the top of this guide).
- Your password manager, open, so every value goes straight into it.

#### Words used here

- SID: Twilio's ID for an account or anything in it, such as `AC…` for an account or `BU…` for a Trust Hub profile.
- Subaccount: an account inside the master account. Each client business gets one. It has its own SID and token but spends the master account's balance.
- Trust Hub: the console area where Twilio checks who a business is.
- A2P 10DLC: the carriers' registration for businesses that text from ordinary 10-digit local numbers.
- ISV: a software company that registers its own clients with the carriers. HandsFreeOS is one.
- Messaging service: a Twilio setting that groups a business's numbers for texting.
- TwiML app: the Twilio setting that says where calls from a browser go.
- Webhook: an address Twilio calls to tell the worker that something happened, such as an incoming text.
- Segment: one billed piece of a text, up to 160 plain characters, or 70 if the text has emoji or other special characters.
- US1: Twilio's United States region.

#### Order of work

Work in this order. Twilio's review of HandsFreeOS's own profile takes days, so start it early.

1. Upgrade the account to paid (Twilio Step 1).
2. Find the master account's SID and Auth Token and save them (Twilio Step 2). Fly Part 6 gives them to the worker with its other secrets, and the worker won't start without them. So do Twilio Steps 1 and 2 before Fly Part 6.
3. Make sure Vercel has `NEXT_PUBLIC_WORKER_URL` (see "Environment variables" in "The web app on Vercel").
4. Lock the account down before the first client buys a number (Twilio Step 3).
5. Create HandsFreeOS's own Trust Hub profile and give its SID to the worker (Twilio Step 4). Toll-free verification can fail until Twilio approves it, so start it right after Twilio Step 1 and do Twilio Step 3 while Twilio reviews it.
6. Test with real phones once the worker is running.

### Twilio Step 1: Upgrade the account to paid

A trial account can only call and text verified numbers. It adds "Sent from a Twilio Trial account" to texts, stops at 50 texts a day, and its subaccounts can't buy numbers. Number purchases, client subaccounts and carrier registrations all need a paid account.

1. Go to `https://console.twilio.com` and sign in with the account that will be the HandsFreeOS master account.
2. Open the upgrade. New console: click the **Trial** banner at the top left, or the **Upgrade your account** button on the right. Legacy console: click **Upgrade** at the top of the screen. In either console you can also search for `Upgrade`.
3. New console only: click **Upgrade**.
4. Click **Continue**.
5. Enter your legal first and last name.
6. Enter your phone number.
7. Select the country of your ID.
8. Select an ID type from the list.
9. Upload a clear photo of the ID.
10. If Twilio asks for a selfie, take it. After three failed attempts you can escalate to Twilio's operations team, who answer within 48 business hours.
11. For **Identity type**, choose the option for a business or organization, not the one for an individual. This answer becomes HandsFreeOS's primary customer profile in Trust Hub (Twilio Step 4). Only a business profile works for toll-free verification and for registering clients' local numbers.
12. If Twilio asks for **Business identity**, choose **ISV Reseller or Partner**, not **Direct Customer**. Twilio Step 4 explains why.
13. Enter the business address.
14. Click **Continue**.
15. On **Main Address**, select the United States. Twilio uses this for tax.
16. Click **Continue**.
17. On **Tax information**, enter the company's EIN.
18. Click **Continue**.
19. On **Fund your account**, pick the starting balance. $50 covers a test number and the real-phone tests. You can add more later.
20. Tick **Auto Recharge** so the balance refills itself.
21. Click **Continue**.
22. On **Payment Method**, enter a card or choose PayPal. Enter the card details yourself.
23. If the card's billing address is different from the business address, untick **Yes, my billing address is the same**.
24. If you unticked it, enter the card's billing address.
25. Click **Confirm Payment**.

You should see that the account is no longer marked as a trial, with the trial banner gone and a balance equal to the amount you funded on the console home page. Any unused trial credit is removed. A number bought during the trial is kept and billed monthly.

### Twilio Step 2: The master account's SID and Auth Token

The worker needs these two values before its first deploy (Fly Part 6).

#### Find the two values

The **Account SID** is 34 characters and starts with `AC`. The **Auth Token** is the password that goes with it. Use the master account's values, not a subaccount's.

- Legacy console: on the home **Dashboard**, find the **Account Info** pane. Copy **Account SID**. Click **show** next to **Auth Token** and copy it.
- New console: open **Workbench**, the panel at the bottom of the console, and copy both values from its **Overview** tab. Twilio documents this only briefly. If you can't find it, use the full page below.
- Either console: go to **Admin** → **Account management** → **API keys & tokens**, or search the console for `API keys & tokens`. Pick the region **United States (US1)** at the top right. The primary token is in the **Auth Tokens** section.

Save both in your password manager in the "Twilio master account" entry. Never commit them or put them in any file in the repository, and never put them in Vercel, GitHub or `handsfreeos-api`.

#### What the worker needs

Two settings are already in `apps/worker/fly.toml` under `[env]`. Don't set them yourself.

| Setting              | Value                           | What it does                                                                                                               |
| -------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TELEPHONY_PROVIDER` | `twilio`                        | Uses real Twilio. In production the worker refuses `fake`, the in-memory carrier used locally.                             |
| `WORKER_PUBLIC_URL`  | `https://hooks.handsfreeos.com` | The address Twilio calls. Every webhook address and every signature check is built from it. It must start with `https://`. |

The rest are Fly secrets on `handsfreeos-worker`, and only there:

| Secret                       | Where it comes from                                         | When                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TWILIO_ACCOUNT_SID`         | The master account's **Account SID** (`AC…`)                | Before the first deploy. The worker won't start without it.                                                                                                        |
| `TWILIO_AUTH_TOKEN`          | The master account's **Auth Token**                         | Before the first deploy. The worker won't start without it.                                                                                                        |
| `TWILIO_PRIMARY_PROFILE_SID` | HandsFreeOS's approved Trust Hub profile (`BU…`)            | After Twilio Step 4. Only local numbers need it.                                                                                                                   |
| `WORKER_ENCRYPTION_KEY`      | Made with `openssl rand -base64 32` and saved in Fly Part 6 | Before the first deploy. It seals each client subaccount's Auth Token and API key secret before they are stored. Without it they can't be opened. Never commit it. |

In production the worker also refuses to start until its other secrets are set: `DATABASE_URL_WORKER` and `SMTP_URL` (Fly Part 6), and `POSTMARK_SERVER_TOKEN`, `POSTMARK_ACCOUNT_TOKEN` and a `POSTMARK_WEBHOOK_PASSWORD` of 24 or more characters (see "Email: Postmark"). `SUPABASE_SECRET_KEY` isn't checked at startup, but without it the worker can't copy voicemails and picture texts into Storage.

#### Check or change the secrets

Fly Part 6 imports both Twilio values with the worker's other secrets.

1. Check which secrets the worker has. This shows names only, never values:

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   If both `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are listed, go to "Watch the worker start" below.

2. If either is missing, or to change them, start an import. It keeps the values out of your shell history (`~/.zsh_history`):

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

3. Paste these two lines, with your values from the password manager in place of the placeholders:

   ```text
   TWILIO_ACCOUNT_SID=<master account SID>
   TWILIO_AUTH_TOKEN=<master account auth token>
   ```

4. Press Return.
5. Press Control-D.

   Fly restarts the worker with the new values. If the worker has never been deployed, add `--stage` to the command in step 2, and the values wait for its first deploy.

#### Watch the worker start

This check only works once the worker is deployed and has all its secrets, including the Postmark ones. If the worker has never been deployed, skip this check now and do it after the first deploy.

1. Open the worker's logs:

   ```bash
   fly logs --app handsfreeos-worker
   ```

   You should see a `worker started` line showing `publicUrl` as `https://hooks.handsfreeos.com` and `telephony` as `twilio`.

2. Press Control-C to stop watching.

If the log shows a Postmark error instead, the Twilio values are fine: finish "Email: Postmark", then look again. Every startup error is listed under "The worker refuses to start" in "Going live, and when something goes wrong". If the log shows `SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is`, set that secret (see "Copy the publishable key and the secret key" in "The database: Supabase (hosted)") before you run the voicemail and photo tests.

The worker only checks that the two Twilio values are present, not that they are right. With a mistyped token it still starts. Twilio then answers 401, and number search in the app shows "The phone carrier did not answer. Try again in a minute." A background job such as buying a number tries 5 times over about a minute, then gives up. The page can then stay on "Setting up {number}. This takes a few seconds." for good (see "A number is stuck on Setting up" in "Going live, and when something goes wrong"). Searching for a number (in the real-phone tests below) is the first real check of both values.

#### Rotate the master Auth Token later

1. On **API keys & tokens**, click **Request a secondary token**.
2. Click **Request Token** in the pop-up.
3. Click the eye icon to see the new token.
4. Save it in your password manager as a new entry. Never commit it.
5. Give the worker the new token before you promote it. Start an import:

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

6. Paste `TWILIO_AUTH_TOKEN=<new master account auth token>`, then press Return and Control-D.
7. Back in Twilio, click **Promote to Primary**. The old token stops working immediately.
8. In your password manager, put the new token in the "Twilio master account" entry and remove the old value.
9. In a HandsFreeOS workspace with no number yet, open **Settings** → **Texting & calls**.
10. Click **Show numbers**. You should see a list of numbers, not "The phone carrier did not answer. Try again in a minute."

Twilio emails every owner and admin when you do this. Each client subaccount has its own token, and rotating the master token doesn't change them. Never rotate a client subaccount's token by hand: the worker keeps its own sealed copy from when it made the subaccount, and Twilio's requests for that client would then fail their signature check.

### Twilio Step 3: Lock the account down

Do this before the first client buys a number. Client subaccounts take the master account's geo permissions by default, so setting the master first covers every client.

#### Geo permissions for calls

HandsFreeOS lets teammates call and text any valid number, including international `+` numbers, from the browser and as forwarding phones. Only number search is limited to the US. Twilio's geo permissions are the only guard against expensive international calls, for example from a stolen teammate login.

1. Go to **Voice** → **Settings** → **Geo permissions**. The path is the same in both consoles. If **Voice** isn't in your menu, pin it from **Explore Products** first.
2. On the **Low Risk** tab, keep only the countries clients call: the United States, plus Canada if a client needs it. Untick everything else.
3. On the **High Risk** tab, untick everything.
4. Click **Save**.

You should see only the countries you chose ticked when you reopen the page. A blocked call fails with Twilio error 13227 (a call the worker dials) or 21215 (a call made through the API). Errors 13225, 21216 and 32203 come from Twilio's own block list, which only Twilio Support can clear.

There is nothing to do in client subaccounts now. Each new one starts with **INHERIT FROM MASTER** on. Never turn it off. After the first client buys a number, open that client's subaccount (see "Number" below), go to **Voice** → **Settings** → **Geo permissions**, and check that **INHERIT FROM MASTER** is still on.

#### Geo permissions for texts

1. Go to **Messaging** → **Settings** → **Geo permissions**.
2. Check that the United States is ticked. A new account allows only its home country, taken from the phone number verified at sign-up.
3. Use **Filter by Country** to add Canada, but only if a client needs it. Leave everything else off.
4. Click **Save geo permissions**.
5. Click **Update geo permissions** in the dialog. If you ever tick a high-risk country, Twilio asks you to tick **I Acknowledge this risk** and click **Enable Geo Permissions** instead.

You should see "Messaging geo permissions updated successfully" at the top right. Changes apply at once. A text to a country that isn't allowed fails with error 21408. Messaging geo permissions can only be changed in the console.

#### Protect recordings and picture texts

Twilio can require a sign-in before anyone downloads a call recording or a picture text. Main accounts created since mid-2023 have this on by default, and new subaccounts copy the main account's setting. It can still be switched off, so check that it reads **Enable** in both places.

1. Open the voice setting. New console: search the console for `Enforce HTTP Auth` (or "HTTP Basic Authentication", or "media access") and open the voice result, because Twilio doesn't document where this setting lives in the new console. Legacy console: go to **Voice** → **Settings** → **General**.
2. Under **Enforce HTTP Auth on Media URLs**, choose **Enable** if it isn't already.
3. Click **Save** at the bottom of the page.
4. Open the messaging setting. New console: search for `Enforce HTTP Auth` again and open the messaging result. Legacy console: go to **Messaging** → **Settings** → **General**.
5. Repeat steps 2 and 3.

You should see **Enable** selected under **Enforce HTTP Auth on Media URLs** on both pages.

This breaks nothing. The worker always signs in with the client subaccount's credentials to download a voicemail or picture. It copies the file into the Supabase Storage bucket `telephony`, then deletes Twilio's copy. A voicemail is deleted from Twilio once its transcript arrives, or at once if it is 2 seconds or shorter.

#### Balance and auto-recharge

Client subaccounts have no balance of their own. They all draw on the master account's balance, so an empty balance can stop calls and texts for every client at once.

1. Open auto-recharge. New console: click the credit-card icon in the left navigation, then **Billing** → **Payment Settings** → **Auto-Recharge**. Legacy console: go to **Admin** → **Account billing**, then click **Enable auto recharge**.
2. Switch **Auto Recharge** to **Enabled**. It is already on if you ticked it during the upgrade.
3. Set **When Balance Falls Below** (at least $10).
4. Set **Recharge Balance To**. One refill can add at most $2,000.
5. Click **Select Payment Method**.
6. Choose the card.
7. Click **Select**.
8. Click **Save**.
9. Open **Payment Methods** in the same billing area. If you can't see it, search the console for `Payment Methods`.
10. Add a second card as a backup, as Twilio recommends.

You should see two cards under **Payment Methods**, and **Auto Recharge** as **Enabled** with your amounts.

#### Low-balance email

1. Open the notifications. New console: **Payment Settings** → **Notifications**. Legacy console: **Payment Settings** → the **Balance Notifications** tab.
2. In the balance field, enter `25` to start. Every account starts at $5, which is too low for a live service. Once clients are live, raise it to about a week of normal spending.
3. Save the change.

You should see the new amount when you reopen the page.

#### Daily spending alert

A usage trigger emails you when spending passes a limit. It only alerts. It never stops anything. Twilio documents the legacy console's button names below. It doesn't publish the new console's, so there, look for the matching button or field.

1. Open usage triggers. New console: click the credit-card icon (**Billing & Usage**), then **Account usage** → **Usage Triggers**. Some of Twilio's pages call this **Usage and Spend** → **Usage Triggers**. Legacy console: **Admin** → **Account billing** → **Usage** → **Triggers**.
2. Start a new trigger. Legacy console: click **Create New Trigger**. New console: click the button that creates a usage trigger.
3. Name it `Daily spend`.
4. Choose total price as the usage category.
5. Choose to trigger by price.
6. Enter `25` as the value, in dollars. Raise it once you know normal daily spending.
7. Choose a daily repeat.
8. Choose email as the notification.
9. Save the trigger. Legacy console: click **Save**. New console: click the form's save or submit button.

You should see the new trigger in the list.

A trigger fires at most once per period, and periods follow GMT. Numbers bought together renew together each month, so set the value high enough that renewal day doesn't set it off.

Twilio's trigger docs don't say whether a trigger on the master account counts the client subaccounts' spending, and Twilio's own examples put triggers inside each subaccount. Twilio's usage records, which triggers read, include every subaccount by default when read for the main account (`IncludeSubaccounts=true`), so a master trigger probably does count client spending. Twilio's alarms, by contrast, are per account and do not see subaccount errors. Confirm the trigger after the first client goes live:

1. Open usage in the master account (search the console for `Usage`).
2. Note that day's text count.
3. Open usage in that client's subaccount.
4. Compare the same day's text count.

If the master's count doesn't include the client's texts, add the same trigger inside each client subaccount.

### Twilio Step 4: HandsFreeOS's own Trust Hub profile

Carriers require every business that texts from a local number to register. This is A2P 10DLC. Because HandsFreeOS registers its clients, Twilio treats it as an ISV: HandsFreeOS needs its own approved business profile, the primary customer profile, and each client's profile is linked under it. The code never creates this profile. You create it once, and the worker only needs its SID.

Toll-free numbers don't use `TWILIO_PRIMARY_PROFILE_SID`. The app sends toll-free verifications without it, so clients can submit them at any time. Twilio's toll-free rules do say the account needs an approved business profile (an individual profile fails with "Approved profile is required"), so a request may fail until HandsFreeOS's profile is approved. Get this profile approved before any client submits business details, toll-free or local. Calls work before that.

#### Check what the upgrade created

The upgrade already made a primary customer profile from your answers. Look at it before you create anything.

1. Open the profiles. New console: **Products & Services** → **Trust Hub** → **Profiles** (Twilio is renaming these **Compliance profiles**), then the **Primary Profile** tab. Legacy console: **Account** → **Trust Hub** → **Customer Profiles**.
2. Read its type, its status and its **Business identity**.
3. Pick the matching case:
   - No profile listed: create a business profile with the steps below.
   - A business profile with **Business identity** set to **ISV Reseller or Partner**: keep it and go to "Wait for Twilio's review".
   - Any other profile in **Pending Review** or **In Review**: it can't be changed during review. Wait for Twilio's answer, then come back to this list.
   - An approved business profile set to **Direct Customer**: only Twilio Support can change an approved profile. Open a support ticket and ask for **ISV Reseller or Partner**.
   - An approved individual profile: it can't be deleted. Open a support ticket and ask how to add a business primary profile set to **ISV Reseller or Partner**.
   - Any other draft or rejected profile: draft and rejected profiles can be deleted. Delete it, then create a business profile with the steps below.

To open a support ticket, go to `https://help.twilio.com` and choose to contact support. If the link has moved, search the console for `Support`. Never paste an auth token into a ticket.

#### Create the business profile

| Field                             | What to enter                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized representative         | First and last name exactly as on the person's government ID, a business email address, a phone number, a business title, and **Job position** (Director, GM, VP, CEO, CFO, General Counsel or Other). Twilio may contact this person. |
| **Business identity**             | **ISV Reseller or Partner**, not **Direct Customer**                                                                                                                                                                                   |
| Legal business name               | Exactly as on the IRS EIN letter                                                                                                                                                                                                       |
| **Business registration ID type** | EIN                                                                                                                                                                                                                                    |
| **Business registration number**  | The company's 9-digit EIN. Type it the way the form's example shows, with or without the dash (for example `12-3456789`).                                                                                                              |
| Business industry                 | For example, Technology                                                                                                                                                                                                                |
| Company type                      | For example, Limited Liability Corporation or Corporation                                                                                                                                                                              |
| Business website URL              | A working site that matches the legal business name. If the legal company isn't called HandsFreeOS, make sure the site names it, for example in the footer.                                                                            |
| Business regions of operations    | USA and Canada                                                                                                                                                                                                                         |
| Social media profile URLs         | Optional                                                                                                                                                                                                                               |

1. Start the profile. New console: on the **Primary Profile** tab, click **Get Started** under **Business Profile**. Legacy console: on **Customer Profiles**, start a new primary customer profile and choose **Business/Organization**. If you can't find the button, search the console for `Customer Profiles`.
2. Fill in the authorized representative.
3. Fill in the business details from the table.
4. Choose **Address country**.
5. Type the address in **Business address**.
6. Pick the matching suggestion.
7. Enter your email in **Notification email**. Twilio writes to this address about the review.
8. Leave **Status Callback URL** empty. The worker has no route for Trust Hub callbacks.
9. Accept the terms of service.
10. Accept the privacy policy.
11. Click the submit button at the bottom of the form.

You should see a success message, and the profile should appear with a review status.

#### Wait for Twilio's review

The status reads **Pending Review** or **In Review** while Twilio checks the profile, and you can't edit it then. Twilio's Trust Hub docs say review takes up to 48 hours. Its ISV 10DLC guide (August 2026) says 72 hours or more.

Twilio writes to the **Notification email** you entered. To see the status, reopen the **Primary Profile** tab (legacy console: **Customer Profiles**).

- **Twilio Approved**: done. The profile can't be edited any more.
- **Twilio Rejected**: open the profile, fix each reason shown, and submit it again.

#### Give the worker the profile's SID

1. Open the approved profile and copy its SID: 34 characters starting with `BU`. If the page layout has moved, look for the value starting with `BU` next to the profile name.
2. Save it in your password manager as "Twilio primary customer profile SID". Never commit it.
3. Set it on the worker. It is an identifier rather than a password, but its name starts with `TWILIO_`, so it goes on the worker only. Start an import, which keeps the value out of your shell history:

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

4. Paste `TWILIO_PRIMARY_PROFILE_SID=<primary customer profile SID>` without quotes, then press Return and Control-D. If the worker has never been deployed, add `--stage` to the command in step 3, and the value waits for its first deploy.

If the worker is deployed and has all its secrets, you should see it restart, with a new `worker started` line in `fly logs --app handsfreeos-worker`.

Until this SID is set, the app still offers local numbers, but their registration stops at once with "Local numbers cannot be registered yet: HandsFreeOS is finishing its own carrier profile. Use a toll-free number for now." The client's page shows this under "The carriers turned down the texting registration.", even though the missing piece is HandsFreeOS's. Nothing retries it. No one gets an email about it either, because the message comes from HandsFreeOS, not the carriers, so the client only sees it on **Texting & calls**. After you set the SID:

1. Ask every client who bought a local number whether their **Texting & calls** page shows this message.
2. Have each client whose page shows it click **Fix and send again**. This works here, because nothing reached Twilio the first time.

Until the SID is set, steer every client to a toll-free number.

### What a client fills in

Clients do this themselves. Only a workspace owner or admin sees **Settings** → **Texting & calls** (`/app/w/<workspace id>/settings/texting`). Until the carriers approve texting, the page has three steps: **Number**, **Business details** and **Carrier review**. After approval it shows the number's settings instead (see "After approval" below).

#### Number

1. Under **Get a business number**, pick **Toll-free** (marked **Faster approval**) or **Local**.
2. For toll-free, choose **Starts with** (**Any**, 833, 844 or 855). For local, type the **Area code**.
3. Click **Show numbers**. Up to 10 US numbers appear, all able to text, send pictures and take calls.
4. Pick one.
5. Click the button that reads **Buy** followed by the number you picked.

You should see "{number} bought. Calls ring now.", then "Setting up {number}. This takes a few seconds." The first message appears as soon as HandsFreeOS accepts the order, before anything is bought. The number is really bought when the page moves on to **Business details for the carriers**. Twilio charges the master account from that moment. Calls work from then on. Texting waits for the carriers. If Twilio refuses the number, the page shows "We couldn’t buy {number}: {reason} Pick another number."

- A workspace can have only one live number ("This workspace already has a business number.").
- **Any** may offer toll-free prefixes other than 833, 844 and 855, such as 800 or 888.
- Only numbers bought here work. A number bought by hand in the Twilio console is unknown to HandsFreeOS (see "Twilio webhooks are rejected" in "Going live, and when something goes wrong").
- Sole proprietors, and businesses without an EIN, must use toll-free. On a local number their registration fails with "Sole proprietors text from a toll-free number. Release this number and pick a toll-free one." But the **Release this number** menu only appears once texting is approved, so a client in this state can't release the number from the page, and can't buy a toll-free one while the local number is live. Until a developer adds a release option to that screen, tell sole proprietors and businesses without an EIN to pick **Toll-free** before they buy.

The first purchase creates these in order: the subaccount `HandsFreeOS <workspace name> <tag>`, the messaging service `HandsFreeOS <tag>`, and an API key and a TwiML app both named `HandsFreeOS calls <tag>`. The `<tag>` is the first 8 characters of the workspace id. Each step is saved as it finishes, so a failure part-way picks up where it stopped. To see them in the Twilio console, open the master account's list of subaccounts and click the subaccount's name. The list is at `https://www.twilio.com/console/project/subaccounts`; in the new console it is under **Settings** → **Account settings** → **Subaccount management**. If neither works, search the console for `Subaccounts`. To return to the master account, use the account menu at the top left.

#### Business details

Under **Business details for the carriers**, the client fills in:

| Field                                                          | Rules                                                                                                                      | Tips                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Legal business name**                                        | 2 to 120 characters                                                                                                        | Exactly as on the IRS EIN letter: no DBA, no abbreviations, no punctuation changes.                                                                                                                                                                                                                                      |
| **Business type**                                              | **Limited liability company (LLC)**, **Corporation**, **Sole proprietor**, **Partnership** or **Nonprofit**                | Sole proprietors can only use toll-free.                                                                                                                                                                                                                                                                                 |
| **EIN (tax ID)**                                               | 9 digits, dash optional; hidden for sole proprietors                                                                       | Required for everyone else, toll-free included. Twilio has required it for toll-free since February 17, 2026.                                                                                                                                                                                                            |
| **Website**                                                    | A full address, up to 200 characters; `https://` is added for you                                                          | Must work and match the business. Toll-free verification sends it as the proof of opt-in, so the website should say that customers agree to texts.                                                                                                                                                                       |
| **Business address**                                           | Street, city, two-letter state, 5-digit ZIP or ZIP+4; US only                                                              |                                                                                                                                                                                                                                                                                                                          |
| **Contact person**                                             | First and last name                                                                                                        | For a local number, this person is sent as the authorized representative, with the title Owner.                                                                                                                                                                                                                          |
| **Contact phone and email**                                    | Both required                                                                                                              | Twilio's own emails about the registration go to this address, not to you. The phone is the default number for **Text me a test**. Use the client's own email and address. Twilio accepts each email address and each street address in at most ten brand registrations, so don't enter your own email for every client. |
| **How customers agree to get texts**                           | 40 to 1,000 characters                                                                                                     | Say where customers give their number and that they agree to texts.                                                                                                                                                                                                                                                      |
| **Two example texts** (local) or **Example texts** (toll-free) | 20 to 320 characters each; local needs both                                                                                | Follow the placeholders: name the business and end with "Reply STOP to opt out." If a local number has only one, the form shows "Local numbers need at least two example texts." under the example texts.                                                                                                                |
| **What you text about**                                        | **Appointments, estimates and customer care**, **Customer care and occasional promotions** or **Marketing and promotions** |                                                                                                                                                                                                                                                                                                                          |
| **Texts a month**                                              | **Under 1,000**, **1,000 to 10,000**, **10,000 to 100,000** or **Over 100,000**                                            | For a local number, **Under 1,000** registers a low-volume brand that skips the paid secondary vetting.                                                                                                                                                                                                                  |

Then:

1. Tick **These details are accurate, and we only text customers who agreed to it.**
2. Click **Submit for approval**.

You should see "Sent to the carriers", then "The carriers are reviewing {business}" with the rows **Number bought**, **Toll-free verification** (or the local steps) and **Texting turns on**.

HandsFreeOS fills in a few values itself. Toll-free sends the opt-in type as verbal. Local numbers send the industry as construction, the regions as USA and Canada, and the representative's job position as Other.

#### Carrier review and how long it takes

Everything is sent from the client's own subaccount:

- **Toll-free**: one toll-free verification request.
- **Local**: four steps in order. First the client's secondary customer profile, linked under HandsFreeOS's primary profile. Then an A2P messaging trust product, then the brand, then the campaign on the client's messaging service. The brand goes in while the profile and trust product are still in review. The campaign waits for the brand's approval.

| Review                             | The page tells the client | What Twilio says (checked September 2026)                                                                            |
| ---------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Toll-free verification             | "Usually a few days"      | Within three business days (API docs); allow 3 to 5 business days (help center)                                      |
| Business profile and brand (local) | "Usually a few days"      | A brand is often decided in minutes. One sent to manual review takes seven business days or more.                    |
| Texting campaign (local)           | "Usually 1 to 3 weeks"    | Every campaign is checked by hand. Twilio's pages range from 5 business days to 10 to 15 days. Plan on 1 to 3 weeks. |

While a registration is in review:

- Calls already work. Texts are blocked in the app with "Texting turns on when the carriers approve your registration." An unverified toll-free number can't text US or Canadian phones at all (Twilio error 30032).
- The worker asks Twilio for news every 15 minutes. The page says "We check every 15 minutes and email you when texting is on. Calls already work."
- The client can't change anything: "The carriers are reviewing this registration. Changes wait until they answer."

When the carriers answer, the workspace's owners and admins get an email:

- Approved: "Texting is on for {business}", linking to the inbox. The page then shows **Calls ready** and **Texting approved**.
- Turned down: "The carriers need a change before {business} can text", linking to **Texting & calls**. The page shows "The carriers turned down the texting registration." with the carriers' reason under "Their reason". If the reason is about consent, it offers a line to copy onto the client's website form. Read the warning below before the client clicks **What to fix** and **Fix and send again**.

Some messages come from HandsFreeOS itself, not the carriers. They show the same "turned down" screen, but only on the page. No email goes out for them:

- "Local numbers cannot be registered yet: …" (see Twilio Step 4).
- "Sole proprietors text from a toll-free number. …" (see "Number").
- "Local numbers need at least two example texts. Add another example and submit again."
- "The carriers need more business details: …" (Twilio's policy check found missing or wrong details before anything was sent).

For these, the client fixes the details and clicks **Fix and send again**, and the details go to Twilio as a new request.

After the carriers themselves turn a registration down, **Fix and send again** doesn't reach Twilio yet. The client sees "Sent to the carriers", but the worker only checks the old, rejected request again. About 15 minutes later the page goes back to "The carriers turned down the texting registration." and the owners and admins get the turned-down email again. This happens for toll-free verification and for every local step (profile, trust product, brand and campaign). Have a developer fix this before any client relies on it: a turned-down registration that is sent again needs a fresh request at Twilio. Until then, if the carriers turn a client down, get a developer's help instead of having the client resubmit. When it is fixed, note that Twilio gives priority review only to edits of a rejected toll-free request made within seven days, so a new request waits in the normal queue.

To look at a client's registration yourself, switch into the client's subaccount in the Twilio console. New console: **Products & Services** → **Trust Hub** → **Registrations** → **Toll-free** or **A2P 10DLC**. Legacy console: **Phone Numbers** → **Manage** → **Active Numbers** for toll-free, or **Messaging** → **Regulatory Compliance** → **A2P 10DLC**.

#### After approval

Once every registration is approved, **Texting & calls** shows the number's card with **Calls ready** and **Texting approved**, the **Text me a test** button, the number's menu (with **Copy number** and **Release this number**), and the **When a customer calls** and **Voicemail** settings. None of these call settings are on the page before approval.

### Webhooks: where Twilio calls the worker

Twilio sends every request to `https://hooks.handsfreeos.com` by POST. All paths sit under `https://hooks.handsfreeos.com/webhooks/twilio/`. Some are written into Twilio when the worker creates each resource in a client subaccount. The rest are built fresh from `WORKER_PUBLIC_URL` on every call or text, so Twilio never stores them.

| Path                                | What it is                                                        | Stored in Twilio                                                                |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `messaging/inbound`                 | An incoming text                                                  | Yes: each number's `SmsUrl` and the messaging service's `InboundRequestUrl`     |
| `messaging/status`                  | Delivery status of a sent text                                    | Yes: the messaging service's `StatusCallback`. It is also sent with every text. |
| `voice/inbound`                     | An incoming call; the answer rings browsers and forwarding phones | Yes: each number's `VoiceUrl`                                                   |
| `voice/status`                      | Status of the whole call                                          | Yes: each number's `StatusCallback` and the TwiML app's `StatusCallback`        |
| `voice/outbound`                    | A call a teammate places from the browser                         | Yes: the TwiML app's `VoiceUrl`                                                 |
| `voice/leg-status`                  | Status of each ringing phone or browser                           | No                                                                              |
| `voice/screen?line=<number>`        | What a forwarding phone hears when it answers                     | No                                                                              |
| `voice/screen-result?line=<number>` | The key pressed on a forwarding phone                             | No                                                                              |
| `voice/dial-result`                 | End of ringing: voicemail or the apology                          | No                                                                              |
| `voice/hangup`                      | Hang-up                                                           | No                                                                              |
| `voice/recording`                   | The voicemail recording is ready                                  | No                                                                              |
| `voice/transcription`               | The voicemail transcript                                          | No                                                                              |

The messaging service is set to ignore the number's own text address, so incoming texts actually follow the messaging service's `InboundRequestUrl`.

The worker also answers:

- `GET https://hooks.handsfreeos.com/healthz`, which returns `{"ok":true}`.
- `POST /v1/telephony/available-numbers` (number search) and `POST /v1/telephony/voice-token` (a one-hour token for browser calls). The web app calls both with the signed-in user's token. The worker checks that token and the user's role in the workspace: number search needs an owner or admin, and a voice token needs an owner, admin or member. `WEB_ORIGINS` (already set in `apps/worker/fly.toml` to `https://app.handsfreeos.com`) lets pages on the web app call the worker from the browser. Number search runs on the master account's credentials.

Every Twilio request is checked against its `X-Twilio-Signature` header. The signature covers `WORKER_PUBLIC_URL`, the path and the posted fields, never the address the request arrived on. It is made with the master Auth Token or the client subaccount's own token. A request that fails the check gets 403 "Invalid signature", and the worker logs `rejected an unsigned or mis-signed webhook`. Accepted requests are stored first and processed after. If processing fails, the worker tries 5 times in all, waiting 5, 10, 20 and then 40 seconds between tries, and then marks the request failed. Handled requests are kept 30 days, failed ones 90 days.

#### If the public address ever changes

There is no re-point script, and no code re-points anything. The address goes into Twilio once, when each resource is created. The worker records it in `app.telephony_accounts.webhook_base_url` but never reads it back, and it never updates resources that already exist.

Changing `WORKER_PUBLIC_URL` breaks every client's calls and texts at once. The worker checks signatures against the new address, so anything Twilio still sends to the old address fails with 403, even if the old hostname still reaches the worker.

- **Keep `hooks.handsfreeos.com`.** If the worker ever moves to another Fly app, region or host, point the `hooks.handsfreeos.com` DNS record at the new place, add its certificate there, and leave `WORKER_PUBLIC_URL` alone. Nothing in Twilio needs to change.
- **If the hostname really must change,** have a developer write a re-point script first. For every client subaccount it has to update each phone number (`SmsUrl`, `VoiceUrl`, `StatusCallback`), the messaging service (`InboundRequestUrl`, `StatusCallback`) and the TwiML app (`VoiceUrl`, `StatusCallback`). Run it straight after changing `WORKER_PUBLIC_URL`, and expect calls and texts to fail until it finishes. To re-point one subaccount by hand, see "Twilio webhooks are rejected" in "Going live, and when something goes wrong".

### How calls behave

- **Nothing to set up per client.** When a business buys its number, the worker also creates what browser calls need in that business's subaccount: an API key (its secret is sealed with the worker's encryption key) and a TwiML app that places the calls teammates make from the browser.
- **Ringing.** An incoming call rings, at the same time, the browsers of up to 10 teammates (those who have turned on calls) and up to 3 forwarding phones. The first to answer takes it. Only members whose role can use the inbox are rung. With more than 10 teammates who can use the inbox, the same 10 always ring. They are picked by an internal id, not by who has calls on, so the others never ring. One teammate's open browsers all ring together. **Ring for** is 20 seconds by default, and 15 or 25 can be chosen.
- **Before approval.** Forwarding phones, **Ring for** and the **Voicemail** settings only appear on **Texting & calls** after the carriers approve texting. Until then every number uses the defaults: calls ring teammates' browsers for 20 seconds, with no forwarding phones, then go to voicemail with the default greeting ("You’ve reached {business}. Leave your name, number and what you need, and we’ll call you back today.").
- **Forwarding phones.** A forwarding phone that answers hears "Call for {business} from {caller}. Press 1 to take it." and has 6 seconds to press a key, so a cell's own voicemail can't take the call.
- **Voicemail.** If nobody answers, the caller hears the greeting and can leave a message of up to two minutes. With **Voicemail** off, callers hear "Sorry, nobody can take your call right now. Please try again later." A number that isn't active answers "Sorry, this number is not in service."
- **Transcripts** use Twilio's built-in voicemail transcription (English, messages up to two minutes). Twilio has marked that feature as deprecated. The assistant in Milestone 4 replaces it.
- **Browser calls.** Each teammate clicks **Turn on calls in this browser** in the app's left sidebar (in the menu on a phone). It then reads "Calls ring in this browser". The browser asks to use the microphone the first time the teammate answers or places a call. The browser gets a one-hour token signed with the client subaccount's own API key. A call from the browser goes through only if the same teammate started it in HandsFreeOS within the last 10 minutes. Otherwise the teammate hears "Sorry, this call could not be placed." The customer sees the business number.
- **Microphones need HTTPS.** Browsers only allow calls from pages served over HTTPS (or localhost). A blocked microphone shows "Your browser blocked the microphone. Allow it in the address bar, then try again."

### Costs

Costs come per number each month, per text and minute, and per registration. They show on the Twilio bill of the master account, and the invoice CSV splits charges by subaccount, so each client's share is visible. The code has no prices in it. The figures below were read from Twilio's pages on September 12, 2026 and will change, so check the pages before quoting a client:

- Texts: [`https://www.twilio.com/en-us/sms/pricing/us`](https://www.twilio.com/en-us/sms/pricing/us)
- Calls: [`https://www.twilio.com/en-us/voice/pricing/us`](https://www.twilio.com/en-us/voice/pricing/us)
- Local-number registration fees: [`https://help.twilio.com/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service-`](https://help.twilio.com/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service-)

| Item                                     | Price                                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| Local number                             | $1.15 a month                                         |
| Toll-free number                         | $2.15 a month                                         |
| Text (SMS), sent or received             | $0.0083 per segment                                   |
| Picture text (MMS)                       | $0.022 per message sent, $0.0165 per message received |
| Failed-message fee                       | $0.001 per failed text, blocked texts included        |
| Call minutes and voicemail transcription | See the voice pricing page                            |

Carrier fees on local-number texts, added to the prices above:

| Carrier            | SMS sent, per segment | SMS received, per segment | MMS sent, per message | MMS received, per message |
| ------------------ | --------------------- | ------------------------- | --------------------- | ------------------------- |
| AT&T               | $0.0035               | $0.0035                   | $0.009                | $0.009                    |
| T-Mobile           | $0.0045               | $0.0025                   | $0.01                 | $0.01                     |
| Verizon            | $0.0045               | $0.007                    | None listed           | None listed               |
| US Cellular        | $0.005                | $0.0025                   | $0.01                 | $0.01                     |
| All other carriers | $0.004                | None listed               | $0.01                 | None listed               |

Twilio's registration-fee help article still says only T-Mobile charges on received texts. The pricing page is the newer source.

Local-number registration, per client. These fees are passed through from The Campaign Registry and the carriers.

| Fee                  | Price                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Brand registration   | $4.50 once                                                                                                |
| Secondary vetting    | $41.50 once, skipped when the client picks **Under 1,000** texts a month                                  |
| Campaign vetting     | $15 per submission, not refundable, and it can be charged again when a rejected campaign is resubmitted   |
| Campaign             | $10 a month for the standard use cases HandsFreeOS registers, from approval until the campaign is deleted |
| Brand vetting appeal | $11 per request                                                                                           |

Twilio's pages show no fee for toll-free verification.

The code keeps a few costs down: the low-volume brand for small senders, the two-minute voicemail limit, and deleting Twilio's copies of recordings and pictures once the worker has copied them. Numbers bill every month until they are released, so release test numbers when you finish (see "Release a test number" below).

### Test with real phones

Do this on the hosted stack before any client relies on calls or texts. It is also Checks 3 to 6 of "The end-to-end check" in "Going live, and when something goes wrong". It runs in two rounds. Round 1 covers the purchase, browser calls and voicemail, right after you buy a number. Round 2 covers forwarding phones and texts, once the carriers approve your toll-free number, which takes days.

There is no practice mode: in production the worker refuses `TELEPHONY_PROVIDER=fake`, so every number, text, call and registration here is real and costs money on the master account's bill.

You need:

- Your cell phone and a second phone.
- To be signed in at `https://app.handsfreeos.com` as the owner of your own workspace.
- The real details of the business you test with: legal name, EIN, website and address. The carriers review them, so use a business you own. Go Biz Help is the simplest choice.
- `SUPABASE_SECRET_KEY` set on the worker. Without it, voicemails and photos can't be saved.
- HandsFreeOS's Trust Hub primary profile approved (Twilio Step 4). Toll-free verification can fail with "Approved profile is required" until it is.

Keep the worker's logs open in a Terminal window for the whole test:

```bash
fly logs --app handsfreeos-worker
```

#### Round 1: right after you buy the number

Add yourself as a customer:

1. Open **Customers** and click **Add person**.
2. Fill in **First name**, **Last name**, **Phone** (your cell) and **Email** (a personal address, not on `handsfreeos.com`).
3. Click **Save person**.

Buy the number and send your details:

4. In your workspace, go to **Settings** → **Texting & calls**.
5. Pick **Toll-free**. Choose **Local** only if `TWILIO_PRIMARY_PROFILE_SID` is set on the worker; until then HandsFreeOS turns local registrations down.
6. Leave **Starts with** on **Any** and click **Show numbers**. You should see a list of numbers. That means the master SID and token are right. If you see "The phone service is not reachable right now. Try again in a minute.", see "Number search says the phone service is not reachable" in "Going live, and when something goes wrong".
7. Pick a number.
8. Click **Buy** followed by the number. You should see "{number} bought. Calls ring now." and then, within a few seconds, **Business details for the carriers**. If the page stays on "Setting up {number}. This takes a few seconds.", see "A number is stuck on Setting up" in "Going live, and when something goes wrong".
9. Fill in **Business details for the carriers** for your own business (see "Business details" above). Put your own mobile and email in **Contact phone and email**.
10. Tick **These details are accurate, and we only text customers who agreed to it.**
11. Click **Submit for approval**. You should see "Sent to the carriers".

Check the number in Twilio:

12. In the Twilio console, open the list of subaccounts (see "Number" above).
13. Click `HandsFreeOS <your workspace name> <tag>`. The tag is the first 8 characters after `/app/w/` in your HandsFreeOS address bar.
14. Search the console for `Active numbers`.
15. Click the new number. You should see its incoming-call webhook set to `https://hooks.handsfreeos.com/webhooks/twilio/voice/inbound`.

Turn on calls:

16. Back in HandsFreeOS, click **Turn on calls in this browser** in the left sidebar. You should see it change to "Calls ring in this browser".

Calls:

17. From the second phone, call the business number. You should see this browser ring, with **Answer** and **Decline**.
18. Click **Answer**.
19. When the browser asks to use the microphone, click **Allow**. You should hear each other both ways.
20. Hang up.
21. Open **Customers**, then your own customer page.
22. Click **Call**. If there's no **Call** button, turn on calls in this browser first.
23. Check that the dialog reads **Caller ID: <business name> · <business number>**.
24. Click **Call**. You should see your cell ring, showing the business number.

Voicemail:

25. From the second phone, call the business number and let it ring out. After about 20 seconds (the **Ring for** setting), you should hear the default greeting.
26. Leave a message longer than 2 seconds, then press `#` or hang up. After a minute or two you should see the voicemail in the inbox, in the conversation with the second phone's number, with its transcript once Twilio sends it.

#### Round 2: once texting is approved

Start when you get the "Texting is on for {business}" email and **Texting & calls** shows **Calls ready** and **Texting approved**. That email also proves the worker's platform mail (`SMTP_URL`) works.

Forwarding phone:

1. Under **When a customer calls**, click **Add a phone**.
2. Enter a name for the phone.
3. Enter your cell number.
4. Click **Add**.
5. Check that **Ring this phone** is on.
6. From the second phone, call the business number. You should see every open browser ring and your cell ring. When you answer the cell, you should hear "Press 1 to take it" before the call connects.
7. Press 1. You should hear the second phone.
8. Hang up.
9. Call again from the second phone and let your cell's own voicemail pick up. You should see the call keep ringing the browsers, then go to the business's voicemail, not the cell's. Twilio's documentation does not say whether the other phones stop ringing at that moment, so this needs checking. Note what happens.
10. When you are done, turn off **Ring this phone** for the cell, or remove it from **When a customer calls**.

Texts:

11. In **Texting & calls**, click **Text me a test**.
12. Check the number in **Your mobile number**.
13. Click **Send**. You should see "Texted a test to {phone}", and "This is a test text from {business} on HandsFreeOS. Replies land in the inbox." arrive on your cell. During quiet hours (8 pm to 8 am in the business's time zone by default), the app asks you to press **Send** again to send it anyway.
14. Reply from your cell. You should see the reply in the inbox within seconds, in a conversation with your phone number.
15. Answer it from the inbox. You should see it arrive on your cell.
16. On your customer page, click **Text**, type a short message, and click **Send text**. You should see the message marked delivered within a minute. That status comes from Twilio's report to the worker, so it also proves the status webhooks work.
17. Send a photo (JPG, PNG or GIF) from your cell. You should see it in the conversation.
18. Text `STOP` from your cell. You should see "Texting is off for {name}. They can text START to turn it back on."
19. Try to text yourself from the inbox. You should see "This customer texted STOP. They can text START to get texts again."
20. Text `START` from your cell.
21. Text yourself again from the inbox. You should see it arrive on your cell.
22. In the sidebar, click **Audit log**. In the box that shows **All activity**, choose **Inbox & texting**. You should see "sent a text to" and "received a text from".

HandsFreeOS sends no automatic reply to STOP or HELP itself. Any reply your cell gets comes from the carrier or Twilio's messaging service defaults. Note whether one arrives, because the settings page tells clients that STOP, START and HELP are "Handled automatically."

Throughout both rounds, you should see no `rejected an unsigned or mis-signed webhook` lines in the logs. The worker checks requests about a client's number with that client subaccount's own token, and Twilio's docs don't confirm that this is the token Twilio signs with. If those lines appear, stop and have a developer look before any client goes live.

#### Release a test number

If you do not keep the number:

1. On the **Business number** card, click the icon button that shows **More** when you point at it.
2. Choose **Release this number**.
3. In **Type <number> to confirm**, type the number exactly as shown.
4. Click **Release number**.

   You should see "{number} is being released", and then the page offers **Get a business number** again. Released numbers cannot be recovered.

### Where to look in the Twilio console

Each client business's texts, calls and errors are logged in its own subaccount, not in the master account. Open the subaccount first (see "Number" above); the pages you open next show that subaccount's data.

- **Errors.** Open the **Debugger**: in the new console **Develop** → **Troubleshoot** → **Debugger**, in the old one **Monitor** → **Logs** → **Errors** → **Error logs**. Click a row's timestamp to see what Twilio sent to `hooks.handsfreeos.com` and what came back. Error 11200 (HTTP retrieval failure) means the worker answered with an error or could not be reached.
- **One text.** Open **Monitor** → **Logs** → **Messaging** (Twilio's Programmable Messaging Logs page, `https://console.twilio.com/us1/monitor/logs/sms`), find it by the phone number, and click its date. The Request Inspector at the bottom lists every status report Twilio sent to the worker. Look up an error code in Twilio's error dictionary (`https://www.twilio.com/docs/api/errors`).
- **One call.** Open the call logs: in the new console **Monitor** → **Logs** → **Voice** → **Calls**, in the legacy console **Monitor** → **Logs** → **Calls**. Click the call's date. The Request Inspector shows each request Twilio made to the worker during the call. Twilio keeps these logs for 90 days.

### When something goes wrong

Startup errors are listed under "The worker refuses to start" in "Going live, and when something goes wrong". The rest:

| What you see                                                                                                                                                                                                           | Where                                 | What to do                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required with TELEPHONY_PROVIDER=twilio`, `TELEPHONY_PROVIDER=fake is for development and tests only` or `WORKER_PUBLIC_URL must be the https:// address providers call` | Worker logs; the worker doesn't start | See "The worker refuses to start" in "Going live, and when something goes wrong".                                                                           |
| `SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is`                                                                                                                              | Worker logs; the worker still starts  | Set `SUPABASE_SECRET_KEY`. Voicemails and picture texts can't be saved until then.                                                                          |
| `The API process must never hold privileged keys. Remove: <names>`                                                                                                                                                     | API logs                              | A Twilio or other provider value was set on `handsfreeos-api`. See "The API refuses to start" in "Going live, and when something goes wrong".               |
| "The phone service is not reachable right now. Try again in a minute."                                                                                                                                                 | Number search or browser calls        | The web app can't reach the worker. See "Number search says the phone service is not reachable" in "Going live, and when something goes wrong".             |
| "The phone carrier did not answer. Try again in a minute."                                                                                                                                                             | Number search                         | Twilio refused or failed the request, most often because of a wrong master SID or token. Check the worker logs.                                             |
| "Setting up {number}. This takes a few seconds." that never ends                                                                                                                                                       | **Texting & calls**                   | The purchase gave up after 5 tries. See "A number is stuck on Setting up" in "Going live, and when something goes wrong".                                   |
| "We couldn’t buy {number}: …"                                                                                                                                                                                          | **Texting & calls**                   | Twilio refused that number. Pick another number.                                                                                                            |
| `rejected an unsigned or mis-signed webhook`                                                                                                                                                                           | Worker logs                           | A Twilio request didn't match `WORKER_PUBLIC_URL` or the expected token. See "Twilio webhooks are rejected" in "Going live, and when something goes wrong". |
| "Local numbers cannot be registered yet: …"                                                                                                                                                                            | The client's **Texting & calls** page | Set `TWILIO_PRIMARY_PROFILE_SID` (Twilio Step 4), then the client clicks **Fix and send again**.                                                            |
| The page shows "The carriers turned down the texting registration." again about 15 minutes after **Fix and send again**                                                                                                | The client's **Texting & calls** page | Resending after a carrier rejection only re-checks the old request. See "Carrier review and how long it takes" and get a developer's help.                  |
| "Calls are still being set up. Try again in a minute."                                                                                                                                                                 | Browser calls                         | The subaccount's API key or TwiML app isn't finished yet. If it lasts, check the worker logs.                                                               |
| Error 30032 on a text                                                                                                                                                                                                  | Twilio's message logs                 | The toll-free number isn't verified yet.                                                                                                                    |
| Error 21408 on a text, or 13227 on a call                                                                                                                                                                              | Twilio's message or call logs         | Blocked by geo permissions (Twilio Step 3).                                                                                                                 |
| Codes from 30001 to 30009 on a text                                                                                                                                                                                    | Twilio's message logs                 | Delivery failures, such as an unreachable phone, a landline, or carrier filtering of the message's wording.                                                 |
| Error 21610 on a text, or "This customer texted STOP. They can text START to get texts again."                                                                                                                         | Twilio's message logs, or the inbox   | The customer texted STOP. HandsFreeOS records the opt-out. They must text START before they can be texted again.                                            |

"Texts do not send" and "Calls do not ring, or cannot be placed" in "Going live, and when something goes wrong" cover the other messages the app shows.

To list the worker's secrets (this shows names only, never values):

```bash
fly secrets list --app handsfreeos-worker
```

To remove a stray `TELEPHONY_PROVIDER` secret from the worker:

```bash
fly secrets unset --app handsfreeos-worker TELEPHONY_PROVIDER
```

To remove a provider value from the API, replacing `<NAME>` with each name the error lists:

```bash
fly secrets unset --app handsfreeos-api <NAME>
```

### Trying real Twilio from a laptop

Locally the worker uses a fake carrier. To try real Twilio from a laptop, follow "Twilio" under "Trying a real provider from your laptop" in "Local development". The laptop then creates its own subaccounts in the master account, pointed at the tunnel's address. Release any number bought that way when you finish, because it keeps billing.

## Email: Postmark

Every business sends from its own address on `mail.handsfreeos.com`, with the business name shown, and customers' replies come back to the same subdomain. The address is made from the workspace's slug, so it looks like `lone-star-3f9a1c@mail.handsfreeos.com` (see "Good to know" at the end). A business can add its own domain in **Settings** → **Email**; once its DNS records verify, it can send from that domain instead.

HandsFreeOS's own mail goes out through Postmark too: invitations and alerts from `alerts@handsfreeos.com`, and Supabase's sign-in emails (confirm your email, reset your password, change your email).

All of this is done by hand, in Postmark's web console, at your DNS provider (Cloudflare), in the Supabase dashboard and with `fly secrets`. There is no setup script. Postmark and Supabase change their consoles from time to time. If a button has moved, each step says what it is for, so search the console or its help pages for that.

### Before you start

- `fly` is signed in on your Mac (see "Before you start" at the top of this guide).
- You can add DNS records for `handsfreeos.com` at Cloudflare.
- You have a company card for Postmark's paid plan (Postmark Part A).
- Your password manager is open. You will make four entries: "Postmark login", "Postmark server API token", "Postmark account API token" and "Postmark webhook password". A fifth, "Postmark SMTP token", comes when you set up Supabase's sign-in email (Postmark Part I).

Do Postmark Parts A to J in order. These things set the order:

- Approval can take a day, so ask for it first. You can do Postmark Parts B to H while you wait.
- Postmark Parts A to D come before the worker's first deploy. "Hosting: the API and the worker on Fly.io" needs the two tokens from Postmark Part C and the verified domains from Postmark Part D: the worker won't start on Fly.io until it has its Postmark secrets, and Fly Part 6 checks the tokens and gives them to it with its other secrets.
- Postmark Parts F to H come after the worker is running at `https://hooks.handsfreeos.com` (Fly Part 8). Postmark tests a webhook before it saves it.
- Supabase's sign-in emails (Postmark Part I) wait until Postmark approves the account. Before that, Postmark refuses mail to most addresses, so sign-up and password reset emails would stop arriving.

### Where each secret lives

| Secret                                 | Copy it from                                                                                                                                        | Put it in                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postmark login password                | You choose it at sign-up                                                                                                                            | Password manager ("Postmark login")                                                                                                                                        |
| Server API token                       | Postmark: **Servers** → **HandsFreeOS Production** → **API Tokens**                                                                                 | Password manager; `handsfreeos-worker` as `POSTMARK_SERVER_TOKEN` and inside `SMTP_URL`; Supabase's SMTP **Username** and **Password** only if you don't use an SMTP token |
| Account API token                      | Postmark: **Account** → **API Tokens**                                                                                                              | Password manager; `handsfreeos-worker` as `POSTMARK_ACCOUNT_TOKEN`                                                                                                         |
| Webhook password                       | You make it (Fly Part 6)                                                                                                                            | Password manager; `handsfreeos-worker` as `POSTMARK_WEBHOOK_PASSWORD`; both Postmark webhooks                                                                              |
| SMTP token (Access Key and Secret Key) | Postmark: **Servers** → **HandsFreeOS Production** → **Default Transactional Stream** → **Settings** → **Generate an SMTP token** (Postmark Part I) | Password manager ("Postmark SMTP token"); Supabase's SMTP **Username** (Access Key) and **Password** (Secret Key)                                                          |

Never commit any of these to this repository or save them in a file inside it. None of them goes on `handsfreeos-api`, in Vercel or in GitHub. The API refuses to start if it has any `POSTMARK_` variable ("The API process must never hold privileged keys."), and CI fails the build if a Postmark token setting shows up in the web app. The SMTP token doesn't go on Fly.io either, because only Supabase uses it.

### Postmark Part A: Create the account and ask for approval

A new Postmark account starts out pending approval. Until Postmark approves it, it refuses mail to anyone outside your own domains, like a customer's Gmail address.

Know this before you apply. Postmark's guide for platforms that send for their customers strongly warns against many customers sharing one sending domain, and it recommends a separate Postmark server for each customer. `mail.handsfreeos.com` is exactly that kind of shared domain, and HandsFreeOS sends every business's mail through one server. So approval may be refused or come with conditions. If you want to lower that risk, talk to the developer before you apply.

1. Go to `https://account.postmarkapp.com/sign_up`.
2. Sign up with your work email address. Postmark refuses Gmail, Yahoo and other public addresses.
3. Save the Postmark password in your password manager as "Postmark login".
4. Answer Postmark's sign-up questions. Describe HandsFreeOS as one-to-one email between small businesses and their own customers, with no marketing or bulk lists.
5. Open `https://account.postmarkapp.com/account/subscription`, the **Plan & add-ons** page in your account.
6. Choose a plan. Customer replies need inbound processing (Postmark receiving mail and passing it on to HandsFreeOS), which only the **Pro** and **Platform** plans include. Free and Basic don't.
   - Every sending domain counts toward the plan's limit: `mail.handsfreeos.com`, `handsfreeos.com`, and each business's own domain. Pro allows 10 in total. Platform has no limit.
   - Pick **Platform** unless you are sure businesses will never add more than 8 domains of their own in total. A workspace can add up to 3. At the time of writing, Pro is $16.50 and Platform $18 a month for 10,000 emails.
7. Ask for approval. Only the Account Owner, the person who created the Postmark account, can do this. Postmark's help only says the option appears inside your account, so look for a banner or button about requesting approval. If you cannot find it, search Postmark's help for "account approval".
8. When the form asks how you will use Postmark, adapt this text:

   ```text
   HandsFreeOS is a CRM for small service businesses. Each business uses it to email its own
   customers one to one: replies, quotes and appointment follow-ups written by the business's
   staff. There are no newsletters, no bulk sends and no purchased lists.

   Each business sends from its own address on our subdomain, <business>@mail.handsfreeos.com,
   under the business's name, or from its own domain once that domain passes DKIM and
   Return-Path checks. Customers' replies come back to mail.handsfreeos.com through inbound
   processing.

   Our own mail (invitations, account alerts and sign-in emails) comes from handsfreeos.com.

   Open and link tracking are off. Hard bounces and spam complaints come back to us by webhook,
   and the app then stops sending to that address.
   ```

You should see an email from Postmark with the result. Review usually takes less than 24 hours on weekdays and a little longer at weekends. If Postmark turns you down and you think that's a mistake, email `support@postmarkapp.com` with examples of the email businesses will send.

Be ready for follow-up questions. The same Postmark guide covers vetting those customers, so be ready to explain how a business gets a HandsFreeOS workspace. If Postmark asks for a change such as a separate stream or server per business, talk to the developer before agreeing. HandsFreeOS sends every business's mail through one server and one stream, so that would mean code changes.

While you wait, do Postmark Parts B to H. Leave Postmark Part I until Postmark approves the account. Invitations and alerts from `alerts@handsfreeos.com` won't reach anyone outside `handsfreeos.com` before approval either.

You can send test emails to `test@blackhole.postmarkapp.com` even before approval. Postmark accepts them and shows them as delivered, but they never reach an inbox.

### Postmark Part B: Set up the production server

Postmark made a first server when you signed up. Make a new one so you choose its type yourself, because a server's type can't be changed later.

A server holds one app's mail, with its own tokens and settings. Inside it, a message stream is a lane: `outbound` for mail you send, `inbound` for mail you receive.

1. Click **Servers** in Postmark's top menu.
2. Click **Create server**. If you cannot find the button, search Postmark's help for "create a server".
3. In the name field, type `HandsFreeOS Production`. The color doesn't matter.
4. Choose **Live Server**, not **Sandbox**. A sandbox server never delivers to a real inbox.
5. Click the button at the bottom of the form to create the server.

You should see the new server with two message streams: **Default Transactional Stream** (Stream ID `outbound`) and the inbound stream (Stream ID `inbound`). A stream's page shows its Stream ID in the top-right corner.

Don't add any streams. Business email uses `outbound`, which is what the worker expects. Every server already has exactly one inbound stream, and Postmark doesn't allow a second. Leave the server Postmark made at sign-up unused.

6. Open the server's **Settings** tab.
7. Check that SMTP is turned on. It is normally on already. If the switch isn't on this tab, look on the **Default Transactional Stream**'s **Settings** tab. Invitations, alerts and Supabase's sign-in emails go out over SMTP, and Postmark only receives customers' replies on `mail.handsfreeos.com` while SMTP is on, so never turn it off.

You should see SMTP turned on.

8. On the same tab, check that open tracking and link tracking are off. Postmark starts with both off. If you can't find them there, look on the `outbound` stream's **Settings** tab, or search Postmark's help for "open tracking". HandsFreeOS turns tracking off on every business email itself, but invitations, alerts and sign-in emails follow this setting.

You should see open tracking and link tracking both off.

### Postmark Part C: Copy the two API tokens

The worker needs two tokens. The server API token sends email. The account API token creates businesses' own domains in your Postmark account.

1. Go to **Servers** → **HandsFreeOS Production** → **API Tokens** tab.
2. Copy the server API token.
3. Save it in your password manager as "Postmark server API token".
4. Click **Account** in Postmark's menu. If you can't find **Account**, search Postmark's help for "Account API token".
5. Open the **API Tokens** tab (the account's, not a server's).

You should see the account API token. Only the Account Owner and Account Admins can see it.

6. Copy the account API token.
7. Save it in your password manager as "Postmark account API token".

Both tokens go on the worker in Fly Part 6, which first checks that each one works. Never commit them, and never give them to `handsfreeos-api`, Vercel or GitHub.

### Postmark Part D: Add the two domains and their DNS records

Words used below. A DNS record is a line at your DNS provider that tells the internet something about a domain. `TXT`, `CNAME` and `MX` are kinds of record. DKIM (a `TXT` record) proves Postmark may send for the domain. Return-Path (a `CNAME` record) is where bounce reports go. MX says which server receives mail for a name. DMARC (a `TXT` record) tells Gmail and Outlook what to do with mail that fails these checks, and where to send reports.

Postmark needs two domains:

- `mail.handsfreeos.com` for business email and customers' replies.
- `handsfreeos.com` for invitations, reminders, "texting is on" notices and reconnect requests (`MAIL_FROM` in `apps/worker/fly.toml` is already `HandsFreeOS <alerts@handsfreeos.com>`) and for Supabase's sign-in emails. Postmark only sends from domains it has verified, so this one isn't optional.

Before you type records at your DNS provider:

- Most DNS providers, Cloudflare included, add `handsfreeos.com` to the end of a name for you. Then you type `pm-bounces.mail`, not `pm-bounces.mail.handsfreeos.com`. Typing the full name there makes the record end in `handsfreeos.com.handsfreeos.com`, and it never verifies. Postmark shows full names, so leave off the `.handsfreeos.com` ending when you copy one.
- If your provider also adds the domain to the end of a CNAME's value, type the value with a dot at the end: `pm.mtasv.net.`
- On Cloudflare, set each CNAME to **DNS only** (grey cloud), not proxied.

#### Get a DMARC report address first

Each domain below gets a DMARC record, and that record names where reports go. Postmark's free DMARC tool gives you a report address, so do this before you add any records.

1. Go to `https://dmarc.postmarkapp.com`.
2. Fill in **Your email address**.
3. Fill in **Send reports about this domain** with `mail.handsfreeos.com`.
4. Copy the record it gives you. It becomes the value of `_dmarc.mail` below. Its `rua=` points at Postmark's report collector. To get reports at your own address as well, list both, separated by a comma, each starting with `mailto:`. If you would rather get reports only at your own address, skip the tool and use `v=DMARC1; p=none; rua=mailto:<your address>` as the value.
5. Check whether `handsfreeos.com` already has a DMARC record:

   ```bash
   dig +short TXT _dmarc.handsfreeos.com
   ```

   If you see a line that starts with `v=DMARC1`, it already has one. Keep that record and skip step 6, because a domain can only have one.

6. Go back to `https://dmarc.postmarkapp.com` and do steps 2 to 4 again with `handsfreeos.com`. That record becomes the value of `_dmarc` below.

Once the records are in DNS, you should see a DMARC digest by email every Monday. Setup can take up to 24 hours.

#### mail.handsfreeos.com

1. In Postmark, click **Sender Signatures** in the top menu.
2. Click **Add Domain or Signature**. If the page has moved, search Postmark's help for "add a domain".
3. If Postmark asks whether you are adding a domain or a single sender signature, choose **Add Domain**.
4. Type `mail.handsfreeos.com`.
5. Click **Verify Domain**.

You should see the domain's DNS settings, with a DKIM record and a Return-Path record. Keep this page open. You can come back to it later with the **DNS Settings** link under the domain.

6. At your DNS provider, add the DKIM record:
   - Type: `TXT`
   - Name: copy the hostname from Postmark's DKIM row. If it ends in `.handsfreeos.com` and your DNS provider adds the domain for you, leave that ending off, so the name reads `<long number>pm._domainkey.mail`.
   - Value: copy the whole value from Postmark's DKIM row, exactly as Postmark shows it. It is a long value that includes `k=rsa;` and `p=` followed by a long key, and it may start with `v=DKIM1;`.
7. Add the Return-Path record:
   - Type: `CNAME`
   - Name: `pm-bounces.mail`
   - Value: `pm.mtasv.net`
8. Add the MX record that brings customers' replies to Postmark:
   - Type: `MX`
   - Name: `mail`
   - Priority: `10`
   - Value: `inbound.postmarkapp.com`
9. At your DNS provider, delete any other MX record on `mail`, and any CNAME on `mail` itself. A name with a CNAME can't have an MX. This doesn't touch the mailboxes on `handsfreeos.com`.
10. Add the DMARC record:
    - Type: `TXT`
    - Name: `_dmarc.mail`
    - Value: the record Postmark's DMARC tool gave you for `mail.handsfreeos.com`. It looks like `v=DMARC1; p=none; pct=100; rua=mailto:<report address>; sp=none; aspf=r;`.
11. Back on Postmark's DNS settings page for `mail.handsfreeos.com`, click **Verify** next to DKIM.
12. Click **Verify** next to Return-Path.

You should see both marked as verified. New records can take a few hours to show up. Postmark keeps checking by itself and says records usually verify within 48 hours.

13. On your Mac, check the MX record:

    ```bash
    dig +short MX mail.handsfreeos.com
    ```

    You should see `10 inbound.postmarkapp.com.`

14. Check the Return-Path record:

    ```bash
    dig +short CNAME pm-bounces.mail.handsfreeos.com
    ```

    You should see `pm.mtasv.net.`

15. Check the DKIM record. Replace `<DKIM hostname from Postmark>`, including the `<` and `>`, with the full hostname from Postmark's DKIM row, ending in `pm._domainkey.mail.handsfreeos.com`:

    ```bash
    dig +short TXT <DKIM hostname from Postmark>
    ```

    You should see the DKIM value from Postmark in quotes. A long value may come back split into several quoted pieces.

16. Check the DMARC record:

    ```bash
    dig +short TXT _dmarc.mail.handsfreeos.com
    ```

    You should see the record that starts with `v=DMARC1`.

#### handsfreeos.com

1. In Postmark, go to **Sender Signatures** → **Add Domain or Signature**.
2. If Postmark asks whether you are adding a domain or a single sender signature, choose **Add Domain**.
3. Type `handsfreeos.com`.
4. Click **Verify Domain**.
5. At your DNS provider, add a `TXT` record with the DKIM name and value from Postmark's DKIM row. If your provider adds the domain for you, leave off the `.handsfreeos.com` ending, so the name reads `<long number>pm._domainkey`. It has its own name, so it sits alongside any DKIM record another service already uses.
6. Add a `CNAME` record with name `pm-bounces` and value `pm.mtasv.net`.
7. Add a `TXT` record with name `_dmarc` and, as its value, the record Postmark's DMARC tool gave you for `handsfreeos.com`. Skip this if `handsfreeos.com` already had a `_dmarc` record (step 5 of "Get a DMARC report address first").
8. Leave the MX records on `handsfreeos.com` as they are. Replies only come in on `mail.handsfreeos.com`.
9. Back in Postmark, click **Verify** next to DKIM.
10. Click **Verify** next to Return-Path.

You should see both marked as verified.

11. Check the Return-Path record:

    ```bash
    dig +short CNAME pm-bounces.handsfreeos.com
    ```

    You should see `pm.mtasv.net.`

12. Check the DKIM record. Replace `<DKIM hostname from Postmark>`, including the `<` and `>`, with the full hostname from Postmark's DKIM row, ending in `pm._domainkey.handsfreeos.com`:

    ```bash
    dig +short TXT <DKIM hostname from Postmark>
    ```

    You should see the DKIM value from Postmark in quotes.

#### SPF

There's nothing to add. Postmark stopped asking for SPF records, because mail passes SPF through the `pm-bounces` Return-Path records above. Leave alone any SPF record `handsfreeos.com` already has for other senders.

#### Tighten DMARC later

Stay at `p=none` until the reports show all your mail passing. `p=none` only collects reports. Then change the record to `p=quarantine`, and later to `p=reject`. Don't skip DMARC. Gmail and Outlook.com require it from anyone who sends them 5,000 or more emails a day. Gmail counts every email from `handsfreeos.com` and all its subdomains together, so every business on `mail.handsfreeos.com` and HandsFreeOS's own mail add up to one total.

#### Businesses' own domains

There's nothing to do in Postmark for each business. When a business adds its domain in **Settings** → **Email**, the worker creates it in your Postmark account with the account API token. The page then shows the business two records: a `TXT` labeled "Proves the mail is yours (DKIM)" and a `CNAME` labeled "Handles bounces (Return-Path)" (`pm-bounces` pointing to `pm.mtasv.net`). A business never adds an MX record. Its domain also shows up in your **Sender Signatures** list and counts toward your plan's domain limit.

### Postmark Part E: The webhook password

Postmark doesn't sign its webhooks. The worker only accepts a webhook that carries the username `postmark` and this password. You make it in Fly Part 6, with `openssl rand -hex 24`, and save it as "Postmark webhook password". Hex (digits and `a` to `f` only) is safe inside a web address, and the worker needs at least 24 characters.

It goes in three places: the worker's `POSTMARK_WEBHOOK_PASSWORD`, the inbound webhook (Postmark Part G) and the events webhook (Postmark Part H). Never commit it. To change it later, follow "Changing the Postmark webhook password" in "Hosting: the API and the worker on Fly.io".

### Postmark Part F: Check the worker's Postmark settings

The worker is the only part of HandsFreeOS that holds Postmark secrets. Fly Part 6 sets the four secrets below with the worker's other secrets, and explains how `SMTP_URL` is built.

| Setting on `handsfreeos-worker` | What to do                                                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTMARK_SERVER_TOKEN`         | A secret: the server API token.                                                                                                                                                                                                                     |
| `POSTMARK_ACCOUNT_TOKEN`        | A secret: the account API token.                                                                                                                                                                                                                    |
| `POSTMARK_WEBHOOK_PASSWORD`     | A secret: the webhook password.                                                                                                                                                                                                                     |
| `SMTP_URL`                      | A secret: `smtp://<server API token>:<server API token>@smtp.postmarkapp.com:587?requireTLS=true`. Use `smtp://`, not `smtps://`: Postmark has no port 465.                                                                                         |
| `EMAIL_TRANSPORT`               | Leave it unset. On Fly.io it is already `postmark`, because `apps/worker/fly.toml` sets `NODE_ENV = "production"`. The only other value, `smtp`, is for local development and tests: it fakes delivery reports and lets any business domain verify. |
| `POSTMARK_WEBHOOK_USER`         | Leave it unset. It defaults to `postmark`, the username in both webhooks.                                                                                                                                                                           |
| `POSTMARK_MESSAGE_STREAM`       | Leave it unset. It defaults to `outbound`.                                                                                                                                                                                                          |
| `MAIL_DOMAIN`                   | Leave it unset. It defaults to `mail.handsfreeos.com`, which the database and the app also have built in, so it can't be changed here.                                                                                                              |
| `MAIL_FROM`                     | Nothing to do. It is already `HandsFreeOS <alerts@handsfreeos.com>` in `apps/worker/fly.toml`, and it isn't a secret.                                                                                                                               |

1. Check that the names are there:

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   You should see `POSTMARK_ACCOUNT_TOKEN`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_WEBHOOK_PASSWORD` and `SMTP_URL` in the list, next to the worker's other secrets. Fly.io shows a digest, never the values.

2. If any is missing, start an import. Paste the missing `NAME=value` lines without quotes, with the values from your password manager, then press Return and Control-D. If the worker is already running, Fly.io restarts it with the new values. If it has never been deployed, add `--stage` and the secrets wait for the first deploy.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

3. If the worker has never been deployed, deploy it now with Fly Part 7, and point `hooks.handsfreeos.com` at it with Fly Part 8.
4. Check that the worker is up:

   ```bash
   curl -s https://hooks.handsfreeos.com/healthz
   ```

   You should see `{"ok":true}`.

5. Right after a deploy or restart, check that the worker is using Postmark:

   ```bash
   fly logs --app handsfreeos-worker
   ```

   You should see a line containing `"msg":"worker started"` with `"email":"postmark"` and `"storage":true` in it. These only show that the values are set; steps 1 to 4 and 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6 show that the tokens work. Each log line is one long line of text. Press Control-C to stop following the logs. If the worker won't start, the log names the missing setting; see "The worker refuses to start" in "Going live, and when something goes wrong".

6. Check that the events webhook accepts your password. Replace `<webhook password>`, including the `<` and `>`:

   ```bash
   curl -i -u 'postmark:<webhook password>' -H 'content-type: application/json' -d '{"RecordType":"Delivery","MessageID":"test-1"}' https://hooks.handsfreeos.com/webhooks/postmark/events
   ```

   You should see a first line ending in `200`, and `{"ok":true}` at the end. The test belongs to no workspace, so nothing is recorded. A `403` means the password doesn't match the worker's `POSTMARK_WEBHOOK_PASSWORD`.

7. Check that the inbound webhook accepts your password:

   ```bash
   curl -i -u 'postmark:<webhook password>' -H 'content-type: application/json' -d '{"MessageID":"test-1","ToFull":[{"Email":"nobody-test@mail.handsfreeos.com"}]}' https://hooks.handsfreeos.com/webhooks/postmark/inbound
   ```

   You should see `200` and `{"ok":true}`. No workspace owns that address, so the worker drops the message.

### Postmark Part G: Set up inbound for customers' replies

Inbound only works while SMTP stays on for the server (step 7 of Postmark Part B).

1. Go to **Servers** → **HandsFreeOS Production**.
2. Click the inbound stream (Stream ID `inbound`).
3. Open its **Settings** tab.
4. In **Inbound Domain**, type `mail.handsfreeos.com`. Postmark calls this inbound domain forwarding; if the field has moved, search Postmark's help for that phrase.
5. In **Webhook**, paste this, with your webhook password in place of `<webhook password>`:

   `https://postmark:<webhook password>@hooks.handsfreeos.com/webhooks/postmark/inbound`

   The inbound stream has no separate username and password boxes, so both go inside the address: the username `postmark` before the colon, the password after it, then `@`.

6. Leave **Include raw email content in JSON payload** unticked. HandsFreeOS doesn't use it, and it makes every reply bigger.
7. Save the settings. Postmark's help doesn't name the button; it is usually at the bottom of the page.

You should see `mail.handsfreeos.com` and the webhook address saved on the **Settings** tab, with no MX warning. If Postmark warns about the MX record, wait a few minutes for DNS and save again. An inbound domain can belong to only one stream in all of Postmark. If Postmark says the domain is taken, contact Postmark support.

8. From your personal email, send a short email to `test@mail.handsfreeos.com`.

   You should see it as **Processed** in the inbound stream's **Activity** within a few minutes. The worker accepts mail for addresses nobody owns and then drops it, so this only proves the MX record, the inbound domain and the webhook password. Postmark Part J tests a real reply.

Take care with this password. If it is wrong, the worker answers `403`, and Postmark stops retrying after a `403`, so that reply is lost. Postmark retries other failures for about 10 hours. After any change here, send a real reply as in Postmark Part J.

### Postmark Part H: Set up delivery events

Delivery, bounce and spam complaint events tell HandsFreeOS what happened to each email. They come from the `outbound` stream, which every business email goes through.

1. Go to **Servers** → **HandsFreeOS Production** → **Default Transactional Stream**.
2. Open the **Webhooks** tab.
3. Click **Add webhook**.
4. In **Webhook URL**, type this, with your webhook password in place of `<webhook password>`:

   `https://postmark:<webhook password>@hooks.handsfreeos.com/webhooks/postmark/events`

   As in Postmark Part G, the username `postmark` goes before the colon and the password after it, then `@`.

5. Tick **Delivery**.
6. Tick **Bounce**. Leave its **Include message content** option off.
7. Tick **Spam Complaint**. Leave its **Include message content** option off.
8. Leave **Open**, **Click** and **Subscription Change** unticked. HandsFreeOS tracks nothing and ignores those events.
9. Leave custom headers empty.
10. Click **Verify webhook**. Postmark sends a test event of each ticked type and needs a `200` answer before it saves. Older Postmark help pages call this **Send test**.
11. Click **Save webhook**.

You should see the webhook listed on the **Webhooks** tab with Delivery, Bounce and Spam Complaint.

- If the form shows separate **Username** and **Password** boxes for basic HTTP auth, you can use those with the plain address `https://hooks.handsfreeos.com/webhooks/postmark/events` instead. Use one way, not both.
- If **Verify webhook** fails, look at the worker's log, then try again:

  ```bash
  fly logs --app handsfreeos-worker
  ```

  The line "rejected a mail event webhook without the right credentials" means the username or password doesn't match (see "Postmark webhooks are rejected" in "Going live, and when something goes wrong").

- If one event type keeps failing later, Postmark pauses that type and emails the account owner. Fix the cause, then verify the webhook again.

### Postmark Part I: Send Supabase's sign-in emails through Postmark

Do this part only after Postmark approves the account (Postmark Part A). Before approval, Postmark refuses mail to anyone outside your own domains, so sign-up confirmations and password resets would stop arriving, including your own.

Supabase Auth sends the sign-up confirmation, password reset and email change emails. Their templates from `supabase/templates` are already in the dashboard. This part only points Supabase at Postmark, and the setting lives in the Supabase dashboard, not in this repository. Follow "Send Auth email through Postmark" in "The database: Supabase (hosted)". It makes a Postmark SMTP token for Supabase, enters it in Supabase's custom SMTP settings, raises Supabase's email rate limit, and tests a sign-up and a password reset.

### Postmark Part J: Test a real send and reply

A real send needs the approved account. Before approval, an email to your own Gmail address shows "Not sent: While your account is pending approval, all recipient addresses must share the same domain as the From address." Postmark's help words the rule more loosely, so before approval the only outside address to rely on is `test@blackhole.postmarkapp.com`.

Before approval, you can still check sending and the delivery events:

1. Follow steps 1 to 11 under "After approval" below, but in **Email** type `test@blackhole.postmarkapp.com` instead of your own address.

You should see the email reach **Delivered**. Nothing arrives anywhere, and there is no reply to test.

After approval, test business email:

1. Sign in at `https://app.handsfreeos.com` and open a workspace you can test in.
2. Open **Settings** → **Email** and note the workspace's address under **Sending address**. The test email comes from it. It looks like `<business-name>-<6 letters and digits>@mail.handsfreeos.com`; copy it from the page rather than typing it.
3. Click **Customers**.
4. Click **Add person**, or open the customer you added for the phone tests.
5. Type a **First name**, and in **Email** type a personal address you can read, like a Gmail address.
6. Click **Save person**.

You should see the person's page.

7. Click their email address under their name (it looks like a link and has an envelope icon), or click **Email**.

You should see the email panel open.

8. In **Subject**, type a subject.
9. In the message box, type a short message.
10. Click **Send email**.
11. Click **Inbox** and open the conversation with that person.

You should see the email's status under it change from **Sending…** to **Sent**, then to **Delivered** with a green double check within a minute, once Postmark's delivery event reaches the worker. If it stays at **Sent**, see "Postmark webhooks are rejected" in "Going live, and when something goes wrong".

12. Open the email in Gmail.

You should see it from the business name at the workspace's address from step 2, like `lone-star-3f9a1c@mail.handsfreeos.com`. Its Reply-To is the same address with `+` and 10 letters and digits added, like `lone-star-3f9a1c+abcde23456@mail.handsfreeos.com`. Gmail shows the Reply-To in the details under the sender's name.

13. In Gmail, open the three-dot menu on the email and choose **Show original**.

You should see `PASS` for SPF, DKIM and DMARC.

14. Reply to the email from Gmail.

You should see the reply in the same conversation in the HandsFreeOS inbox within a minute. The inbound stream's **Activity** tab in Postmark shows it too, as **Processed**.

15. Optional: email the workspace address from another address that is not a customer.

You should see it in **Settings** → **Email** under **Mail from people not in Customers**, with **Add or link** and **Dismiss**.

Test platform mail:

16. In HandsFreeOS, click **Members**.
17. Click **Invite teammate**.
18. In **Email address**, type an address you can read that isn't a member yet.
19. Click **Send invite**.

You should see an invitation arrive from `HandsFreeOS <alerts@handsfreeos.com>`.

Test sign-in mail:

20. In the left sidebar, next to your name, click the sign-out icon. Its tooltip says **Sign out**.

You should see the sign-in page.

21. Click **Forgot password?**.
22. In **Email**, type your email address.
23. Click **Send reset link**.

You should see a reset email arrive from `HandsFreeOS <no-reply@handsfreeos.com>`. All of these emails should be listed on the `outbound` stream's **Activity** tab in Postmark.

Optional bounce test: email a made-up address at a domain whose mail you control. You should see **Bounced:** and a reason under the email, and the address in **Settings** → **Email** → **Blocked addresses**. Postmark then refuses that address for every business, so use one nobody will need.

To test a business's own domain, see "Check 8 (optional): the business's own domain" in "Going live, and when something goes wrong".

### Where to look in Postmark

1. Sign in to Postmark, open **Servers**, and pick the production server.
2. For mail to customers, open the outbound stream, then **Activity**, and search for the customer's address.
   - **Processed** means Postmark handed it to its mail servers.
   - **Delivered** means the customer's mail server accepted it. It can still land in spam.
   - **Delayed** means the receiving server asked Postmark to wait, and Postmark keeps trying.
   - **Bounced** means it came back.
   - **Queued** means accepted but not yet sent.
   - Opens and clicks never show, because HandsFreeOS turns tracking off.
   - If the search finds nothing, Postmark never accepted the message. Look for Postmark's error in `fly logs --app handsfreeos-worker`.
3. For customers' replies, open the inbound stream, then **Activity**.
   - **Processed** means the worker took it.
   - **Scheduled** means the worker answered with an error and Postmark will try again. Postmark retries 10 times over about 10 hours (after 1 minute, 5 minutes, 10 minutes three times, 15 minutes, 30 minutes, 1 hour, 2 hours and 6 hours).
   - **Failed** (Postmark may label it **Inbound Error**) means Postmark gave up. A 403 from the worker (wrong webhook password) stops the retries at once.
4. The outbound stream's **Webhooks** tab holds the delivery and bounce webhook. The inbound webhook address is on the inbound stream's **Settings**.
5. The stream's **Suppressions** tab lists addresses Postmark will not send to.

Postmark keeps Activity for 45 days by default. Sign-in email from Supabase and platform mail from the worker land in the same outbound stream, because SMTP uses the default `outbound` stream.

### If something doesn't work

Several checks below read the worker's log. Open it with this, and press Control-C to stop following it:

```bash
fly logs --app handsfreeos-worker
```

- **An email shows "Not sent: While your account is pending approval, …".** Postmark hasn't approved the account yet (Postmark Part A).
- **An email shows "Not sent: This address bounced or reported spam before, so the mail service won’t send to it."** Postmark has stopped that address on the `outbound` stream. HandsFreeOS adds it to the workspace's **Blocked addresses** as well. See "Emails bounce or are blocked" in "Going live, and when something goes wrong".
- **An email stays at Sent and never shows Delivered.** The delivery events aren't arriving. Check the webhook on the **Default Transactional Stream**'s **Webhooks** tab, and look in the log for "rejected a mail event webhook without the right credentials".
- **An email with attachments stays at Sending… and never goes out.** The worker reads attachments from Supabase Storage before it sends, so it needs `SUPABASE_SECRET_KEY`. Without it, the worker keeps retrying the send instead of showing why. Check the key with steps 5 to 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6 (the `"storage":true` field in the `worker started` line only shows that a key is set), and look in the log for "Storage is not configured".
- **A reply never shows up.** Run the `dig` check for the MX record in Postmark Part D. Check **Inbound Domain** and **Webhook** on the inbound stream's **Settings** tab, and that SMTP is on for the server (Postmark Part B). Look in the log for "rejected an inbound mail webhook without the right credentials". The inbound stream's **Activity** tab shows whether the reply reached Postmark and what the worker answered. Replies to an email the business sent go into that conversation, whoever sends them. New mail sent straight to a workspace address by someone who isn't in Customers, and who has no conversation yet, waits in **Settings** → **Email** under **Mail from people not in Customers**.
- **A reply with attachments keeps failing.** The worker saves attachments to Supabase Storage as the reply arrives, so it needs `SUPABASE_SECRET_KEY`. Without it the worker answers with an error, and Postmark retries for about 10 hours.
- **Invitations or alerts don't arrive.** See "Invitations, reminders and notices do not arrive" in "Going live, and when something goes wrong". Before approval, they only reach addresses on `handsfreeos.com`.
- **Password reset emails don't arrive.** See "Sign-in emails do not arrive" in "Going live, and when something goes wrong". Before approval, Postmark refuses them.

### Good to know

- **Stopped addresses are shared.** Postmark stops an address for the whole stream after a hard bounce or a spam complaint, so a bad address one business used is stopped for every business. After a spam complaint, you can't reactivate the address yourself. Only Postmark support can, and only if the recipient asks for it. HandsFreeOS also keeps each business's own list, shown in **Settings** → **Email** → **Blocked addresses**. If a business ever needs its own list, it can move to its own Postmark stream or server later; HandsFreeOS sends through one stream today, so that needs a code change. Invitations, alerts and sign-in emails share the `outbound` stream with the businesses too.
- **Replies always route through `mail.handsfreeos.com`,** even for a business on its own domain, so a business never needs MX changes on its own domain.
- **Nothing is tracked.** Open and link tracking are off for customer email. The worker turns them off on every business email. Keep them off in the server's settings so invitations, alerts and sign-in emails stay untracked too.
- **A business's domain is only checked on request.** When a business adds its domain, HandsFreeOS creates it in Postmark and shows the records. HandsFreeOS only checks the records when someone presses **Check now** in **Settings** → **Email**. It shows as verified only when both DKIM and Return-Path pass. The page says "We check once a day and email you when it works", but no daily check or email exists yet, so tell businesses to press **Check now** after adding their records. A workspace can add up to 3 domains. HandsFreeOS refuses `handsfreeos.com` and its subdomains, public email domains such as `gmail.com` or `outlook.com`, and a domain another workspace already uses.
- **Workspace addresses come from the workspace's slug.** HandsFreeOS makes the slug from the workspace name when the workspace is created: lower-cased, `&` becomes `and`, anything other than letters and digits becomes `-`, cut at 40 characters, then a dash and 6 random letters and digits, like `lone-star-3f9a1c`. The address is that slug at `mail.handsfreeos.com`. Renaming the workspace later doesn't change the address. **Settings** → **Email** shows each workspace's address under **Sending address**. In the rare case that the address is reserved (like `support` or `info`) or already taken, HandsFreeOS puts `team-` in front or adds `-2`, `-3` and so on.
- **Attachments are capped at 10 MB per email.** HandsFreeOS adds up the attachments' sizes and refuses more than 10 MB when you press **Send email**. Postmark's own 10 MB limit covers the whole message after encoding, which adds about a third, so in practice keep attachments under about 7 MB. An email over Postmark's limit shows **Not sent**.
- **Automatic mail is skipped.** Out-of-office replies and mailing-list mail that reach `mail.handsfreeos.com` don't go into conversations.
- **The webhook addresses are typed into Postmark by hand.** If `hooks.handsfreeos.com` ever changes, update both webhooks in Postmark.
- **Changing the webhook password.** Change `POSTMARK_WEBHOOK_PASSWORD` on the worker and both webhooks in Postmark one right after the other, at a quiet time, with "Changing the Postmark webhook password" in "Hosting: the API and the worker on Fly.io". Postmark doesn't retry anything the worker refuses while the two differ. Replies are lost, and so are delivery, bounce and spam events: emails sent in that gap stay at **Sent**, and a bounced address isn't blocked.
- **Changing a token.** Postmark allows up to 3 tokens of each kind at once. Make a new one, switch every place that uses it, then delete the old one. The server API token is in `POSTMARK_SERVER_TOKEN` and inside `SMTP_URL` (change both in one import), and in Supabase's SMTP settings only if Supabase uses it instead of an SMTP token. The account API token is only in `POSTMARK_ACCOUNT_TOKEN`. The SMTP token is only in Supabase.
- **Leave IP Allowlist off.** Postmark offers it in the account's and each server's settings, and it is off unless you turn it on. Fly.io doesn't give the worker a fixed outgoing address, so turning it on would make every business email the worker sends through Postmark's API fail with error 1480. SMTP mail isn't checked, but keep it off anyway.
- **Locally, nothing reaches Postmark.** The worker sends through Mailpit instead (see "What the stand-ins do" in "Local development").
- **Gmail waits on Google.** **Settings** → **Email** shows Connect Gmail as waiting on Google's review until the web app is built with `NEXT_PUBLIC_GMAIL_ENABLED=true`. Turn it on once Google approves the restricted scopes (see "Turn Gmail on for everyone" in "Connected mailboxes: Outlook and Gmail").

## Connected mailboxes: Outlook and Gmail

A teammate can connect their Outlook or Gmail mailbox in **Settings** → **Email**. HandsFreeOS then brings in email between that mailbox and people in Customers (nothing else is stored), and replies written in the inbox can go out through it. Outlook works for every client once the Microsoft app exists and the worker has its values. Gmail stays switched off in the web app until Google finishes its security review.

Words used below:

- Tenant: a company's directory of Microsoft work accounts.
- Client ID: the public ID of the HandsFreeOS app at Microsoft or Google.
- Client secret: the app's password. Only the worker holds it.
- Redirect URI: the address Microsoft or Google sends the browser back to after sign-in.
- Consent screen: the page where a person approves what HandsFreeOS may do.
- Scope or permission: one thing the app asks to do, such as read mail.
- Seal: encrypt with `WORKER_ENCRYPTION_KEY` before saving to the database.

How a sign-in travels, so the steps below make sense: **Connect Outlook** or **Connect Gmail** sends the browser to the worker at `https://hooks.handsfreeos.com/oauth/<provider>/start`. The worker sends it on to Microsoft or Google. After the person approves, Microsoft or Google sends the browser back to `https://hooks.handsfreeos.com/oauth/<provider>/callback`. The worker seals the sign-in with `WORKER_ENCRYPTION_KEY`, stores it, and returns the browser to **Settings** → **Email**.

### Before you start

- The worker is deployed and answers on its public address.

  ```bash
  curl -s https://hooks.handsfreeos.com/healthz
  ```

  You should see `{"ok":true}`.

- Vercel's Production environment has `NEXT_PUBLIC_WORKER_URL` set to `https://hooks.handsfreeos.com` (see "Environment variables" in "The web app on Vercel"). Without it, the Connect buttons send the browser to `http://127.0.0.1:4100`, and the sign-in fails.
- The worker's `SMTP_URL` works. The "Reconnect your mailbox" emails go out through it, from `alerts@handsfreeos.com` (`MAIL_FROM` in `apps/worker/fly.toml`). Before Postmark approves the account, this mail only reaches addresses on `handsfreeos.com`. If you have no mailbox there, do this check after approval. To check it, invite yourself:

  1. In HandsFreeOS, open **Members**.
  2. Click **Invite teammate**.
  3. Enter an address you can read.
  4. Click **Send invite**.

     You should see the invitation arrive from `alerts@handsfreeos.com`. If it doesn't, check that Postmark has approved the account, and that `handsfreeos.com` is a verified sending domain in Postmark (Postmark Part D).

- Three public pages on `handsfreeos.com`. This guide uses `https://handsfreeos.com` (a home page that describes HandsFreeOS), `https://handsfreeos.com/privacy` and `https://handsfreeos.com/terms`. If yours differ, use yours everywhere below. Microsoft's branding and Google's consent screen link to them, and Google's review checks them. Nothing in this repository serves those pages (the web app lives at `app.handsfreeos.com` on Vercel), so publish them first on any website host, and point `handsfreeos.com` at that host at your DNS provider. Stage 0 of the go-live checklist in "Going live, and when something goes wrong" walks through it. The privacy policy must say how Google user data is accessed, used, stored and shared. It must also say HandsFreeOS follows Google's Limited Use requirements: the data is used only for features people see in HandsFreeOS, and is never used for ads or sold.

  ```bash
  curl -sI https://handsfreeos.com/privacy
  ```

  You should see `200` on the first line (for example `HTTP/2 200`). Repeat for `https://handsfreeos.com` and `https://handsfreeos.com/terms`.

- You are an owner or admin of a HandsFreeOS workspace. Only owners and admins can open **Settings** → **Email** and connect a mailbox. To check that the Connect buttons reach the worker:

  1. Open **Settings** → **Email**.
  2. Click **Connect Outlook**.

     You should see a page whose address starts with `https://hooks.handsfreeos.com/`. Before the Microsoft values are set, it is titled "Outlook isn’t set up yet"; click **Back to Settings**. If the browser goes to `127.0.0.1` instead, `NEXT_PUBLIC_WORKER_URL` is missing. The **Connecting** row this leaves in the list goes away after ten minutes.

All four sign-in values go on the worker only (`handsfreeos-worker`) and in your password manager. The client IDs are not secret, but the API refuses to start if it sees any name that starts with `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_` (it stops with "The API process must never hold privileged keys. Remove: ..."). Never commit any of these values, never put them in a `.env` file in this repository, and never add them to `handsfreeos-api`, GitHub or Vercel.

| Name                            | Copy it from                                                                  | Put it in                                                             |
| ------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `MICROSOFT_OAUTH_CLIENT_ID`     | Entra app → **Overview** → **Application (client) ID**                        | `handsfreeos-worker` and the password manager ("Microsoft Entra app") |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | Entra app → **Certificates & secrets** → the secret's **Value** (shown once)  | `handsfreeos-worker` and the password manager ("Microsoft Entra app") |
| `GOOGLE_OAUTH_CLIENT_ID`        | **Google Auth platform** → **Clients** → your client → **Client ID**          | `handsfreeos-worker` and the password manager ("Google Gmail client") |
| `GOOGLE_OAUTH_CLIENT_SECRET`    | The same client's **Client secret** (shown in full once)                      | `handsfreeos-worker` and the password manager ("Google Gmail client") |
| `NEXT_PUBLIC_GMAIL_ENABLED`     | Not a secret. `true` only after Google approves, or briefly for your own test | Vercel, Production environment                                        |

Leave `MAILBOX_PROVIDER` and `MAILBOX_SYNC_MS` unset on the worker. In production the worker always uses the real providers and refuses `MAILBOX_PROVIDER=fake`.

`WORKER_PUBLIC_URL` (`https://hooks.handsfreeos.com`) and `WEB_URL` (`https://app.handsfreeos.com`) are already in `apps/worker/fly.toml`. Every redirect URI and notification address below is built from `WORKER_PUBLIC_URL`. If that address ever changes, the redirect URIs in the Entra app and the Google client must change with it.

Both web app values in this section, `NEXT_PUBLIC_WORKER_URL` and `NEXT_PUBLIC_GMAIL_ENABLED`, are set in Vercel with the steps in "Environment variables" in "The web app on Vercel", and take effect only after "Redeploy after a change" in the same section. Enter each value exactly as this guide gives it, in the same case.

### Microsoft (Outlook and Microsoft 365)

Microsoft renames its admin center menus from time to time. If a menu below has moved, search the admin center for the page name (for example "App registrations").

#### What you need first

- A work account in a Microsoft Entra tenant, ideally Go Biz Help's Microsoft 365 tenant. A personal Microsoft account (outlook.com, hotmail.com) won't do: Microsoft no longer lets personal accounts register apps outside a directory, and an app registered that way can never be publisher verified.
- At least the **Application Developer** role in that tenant to register the app. Microsoft's steps for adding permissions assume **Cloud Application Administrator**. A **Global Administrator** has both.
- The same tenant you will later enroll in Microsoft's partner program with. Publisher verification needs them to match.

If Go Biz Help has no Microsoft 365 or Entra tenant:

1. Open `https://azure.microsoft.com/free` and sign up. This creates a tenant called **Default Directory** and makes you its **Global Administrator**. Microsoft may ask for a card to confirm who you are.
2. If you signed up with a personal Microsoft account, open `https://entra.microsoft.com` and go to **Entra ID** → **Users**. If the menu has moved, search the admin center for "Users".
3. Create a new user, such as `admin@<your tenant>.onmicrosoft.com`.
4. Give that user the **Global Administrator** role.
5. Sign out, and do every step below signed in as that user.

If you created the tenant yourself, you already have every Entra role this section needs. Otherwise, open your own user under **Entra ID** → **Users** and check its assigned roles.

#### Register the app

1. Open `https://entra.microsoft.com` and sign in with the work account.
2. If you belong to more than one tenant, click the **Settings** (gear) icon in the top bar and switch to the right tenant under **Directories + subscriptions**.
3. In the left menu, go to **Entra ID** → **App registrations**.
4. Click **New registration**.
5. In **Name**, enter `HandsFreeOS`. People see this name on Microsoft's consent screen. You can change it later.
6. Under **Supported account types**, choose **Any Entra ID Tenant + Personal Microsoft accounts**. Older screens call it **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**. The worker signs in through Microsoft's `common` endpoint, which serves work, school and personal accounts. A single-tenant choice breaks every sign-in (Microsoft error `AADSTS50194`), and a work-and-school-only choice locks out personal Outlook.com accounts.
7. Leave **Redirect URI** empty. You add it in the next part.
8. Click **Register**.

   You should see the app's **Overview** page.

9. Copy **Application (client) ID** into a new password manager entry named "Microsoft Entra app". This is `MICROSOFT_OAUTH_CLIENT_ID`. You don't need the **Directory (tenant) ID**.

#### Add the redirect URI

1. On the app, under **Manage**, click **Authentication**.
2. Click **Add Redirect URI** (on the **Redirect URI configuration** tab). Older screens show **Add a platform** instead.
3. Click the **Web** tile. Don't pick **Single-page application**: SPA sign-ins expire after a day, and the worker is a server that holds a client secret.
4. In **Redirect URI**, enter exactly `https://hooks.handsfreeos.com/oauth/microsoft/callback` (lower case, no trailing slash).
5. Leave **Front-channel logout URL** empty, and leave any **Access tokens** or **ID tokens** boxes unticked.
6. Click **Configure**.

   You should see `https://hooks.handsfreeos.com/oauth/microsoft/callback` listed under **Web**, not under single-page application.

If this address doesn't match exactly, Microsoft stops the sign-in with error `AADSTS50011`.

#### Add the Microsoft Graph permissions

1. On the app, click **API permissions**. `User.Read` is already listed; every new app gets it.
2. Click **Add a permission**.
3. Click **Microsoft Graph**.
4. Click **Delegated permissions**.
5. Use the search box to find and tick `offline_access` (under **OpenId permissions**).
6. Find and tick `Mail.Read`, `Mail.ReadWrite` and `Mail.Send` (under **Mail**).
7. Click **Add permissions**.

   You should see five rows under **Configured permissions**, all of type **Delegated**: `User.Read`, `offline_access`, `Mail.Read`, `Mail.ReadWrite` and `Mail.Send`.

This list matches what the worker asks for in `apps/worker/src/mailbox/graph.ts`. `offline_access` keeps the sign-in alive, `User.Read` tells the worker which mailbox it is, `Mail.Read` is what Outlook's change notifications need, and `Mail.ReadWrite` and `Mail.Send` read the mail and send replies. The worker refuses a connection where `Mail.ReadWrite` or `Mail.Send` wasn't granted. Don't add anything else. When a client's admin approves HandsFreeOS for their whole organization, Microsoft grants what is listed here, so a missing row means blocked connections later.

The **Admin consent required** column says **No** for all five. That is true of the permissions themselves, but a client's own consent settings can still require an admin's approval; see "Business clients: admin approval" below. Don't click **Grant admin consent for** your tenant unless you want to pre-approve HandsFreeOS for Go Biz Help's own tenant. It does nothing for client tenants.

#### Create the client secret

1. On the app, click **Certificates & secrets**.
2. Open the **Client secrets** tab.
3. Click **New client secret**.
4. In **Description**, enter something that shows the date, such as `hfos-worker 2026-09`.
5. In **Expires**, choose the longest option, the one that ends in **(24 months)**. If the list has changed, choose **Custom** and set an end date 24 months from today. Microsoft doesn't allow longer. Microsoft recommends less than 12 months, which is safer but means rotating more often.
6. Click **Add**.
7. Copy the **Value** column right away, not the **Secret ID**. Microsoft shows the value only once; after you leave the page it is hidden for good.
8. Paste it into the "Microsoft Entra app" entry in your password manager, with its expiry date. This is `MICROSOFT_OAUTH_CLIENT_SECRET`. Never commit it or paste it into a file in this repository.
9. Put the expiry date in your calendar, with a reminder three weeks before. When the secret lapses, every Outlook mailbox stops syncing until a new secret is set (see "Rotating the client secrets" below).

Microsoft's documentation now prefers certificates to client secrets. The worker supports only a secret, so use a secret.

#### Give the worker the Microsoft values

1. Start an import on the worker. It keeps the values out of your shell history.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

2. Paste these two lines, with the values from your password manager in place of the placeholders, then press Return and Control-D:

   ```text
   MICROSOFT_OAUTH_CLIENT_ID=<Application (client) ID>
   MICROSOFT_OAUTH_CLIENT_SECRET=<Microsoft client secret value>
   ```

   You should see the command finish without an error once Fly has restarted the worker.

3. List the worker's secrets.

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   You should see `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET` in the `NAME` column. Fly shows only names and digests, never the values.

4. In HandsFreeOS, open **Settings** → **Email**.
5. Click **Connect Outlook**.

   You should see Microsoft's sign-in page. If you see a HandsFreeOS page titled "Outlook isn’t set up yet", one of the two values is missing. Go back for now; the **Connecting** row this leaves goes away after ten minutes.

6. Optional: open the worker's log right after the restart.

   ```bash
   fly logs --app handsfreeos-worker
   ```

   You should see a `worker started` line that includes `"publicUrl":"https://hooks.handsfreeos.com"`. Press Control-C to stop the log. That line doesn't show whether the Microsoft values are set; steps 3 to 5 check that.

Connect Outlook has no switch in the web app. As soon as the worker has these values, the owners and admins of every workspace can connect Outlook.

#### The notification addresses Graph calls

There is nothing to enter in the Entra admin center for these. When an Outlook mailbox connects, the worker asks Microsoft Graph to watch that mailbox's Inbox and to call:

- `https://hooks.handsfreeos.com/webhooks/graph/notifications` when new mail arrives.
- `https://hooks.handsfreeos.com/webhooks/graph/lifecycle` when Microsoft drops the watch or wants it renewed.

Before Graph accepts these addresses, it checks them by sending a test token that the worker sends straight back. So `hooks.handsfreeos.com` must be live over HTTPS before the first real Outlook connection. Each watch lasts three days, and the worker renews it a day ahead. A notification only brings that mailbox's next check forward, and the worker ignores any notification that doesn't carry the secret value it gave Microsoft for that mailbox (the log then shows `ignored an Outlook notification with the wrong clientState`).

If Graph can't reach the worker, the log shows `no Outlook notifications for now`. Mail still comes in through the regular check every five minutes, and the worker tries to set up notifications again about six hours later.

To check the address Graph calls, send it a test token:

```bash
curl -s -X POST 'https://hooks.handsfreeos.com/webhooks/graph/notifications?validationToken=hello'
```

You should see `hello`.

#### Test Outlook with a personal account

Test sign-in now, before branding and publisher verification. Use a personal Outlook.com account first; it needs no admin approval. You test a Microsoft 365 account after "Business clients: admin approval" below.

1. In HandsFreeOS, open **Customers**.
2. Open the **People** tab. It is the one that opens first.
3. Click **Add person**.
4. In **First name**, enter a name.
5. In **Email**, enter an address you control outside the test mailbox (for example, a Gmail address).
6. Click **Save person**.

   You should see the person in the **People** list. HandsFreeOS only brings in mail with people in Customers. Mail with anyone else is skipped and not stored, and it doesn't appear under **Mail from people not in Customers** either.

7. Open **Settings** → **Email**.
8. Under **Connected mailboxes**, click **Connect Outlook**.
9. On Microsoft's page, pick or enter the test account and sign in.
10. On the consent screen, check that it lists reading and sending mail, leave every box ticked, then click **Accept** (a personal account may show **Yes**). Until publisher verification is done, it shows **Unverified** under the app name.

    You should see **Settings** → **Email** again with the message "Connected. Email with customers comes in over the next few minutes." and a row for the account with the badge **Connected**.

11. From the customer's address, send an email to the test mailbox.

    You should see it in the HandsFreeOS **Inbox** and on the person's page in **Customers** within about a minute, and at the latest with the five-minute check. The first sync also looks back 30 days.

12. Open that conversation in the **Inbox**.
13. Write a reply.
14. As the sender, choose `From <account> (Outlook)`, where `<account>` is the test account.
15. Send the reply.

    You should see the reply marked "sent through Outlook", arrive at the customer's address in the same thread, and a copy in the test mailbox's **Sent Items**. The next check matches that copy to the same message, so it doesn't show twice in HandsFreeOS. Mail sent through a mailbox stops at "sent"; there is no delivered report.

16. Check the worker's log for problems.

    ```bash
    fly logs --app handsfreeos-worker
    ```

    You should see no `a mailbox did not connect`, `mailbox sync failed` or `no Outlook notifications for now` lines. Press Control-C to stop the log.

17. Optional: test a lost sign-in. Remove HandsFreeOS from the test account's app permissions. For a personal account, use `https://account.live.com/consent/Manage`; if that has moved, sign in at `https://account.microsoft.com` and search for "apps and services". For a work account, use `https://myapps.microsoft.com`.

    You should see the mailbox change to **Needs reconnecting**, and receive a "Reconnect your Outlook mailbox" email, usually within an hour and a half. Click **Reconnect** to finish the test.

#### Branding and the publisher domain

You can start this while you test. Publisher verification takes several business days.

The publisher domain tells people which company is behind the app, and publisher verification needs it. Proving the domain through DNS is simplest, because nothing in this repository serves files on the bare `handsfreeos.com`.

Add `handsfreeos.com` to the tenant (needs at least the **Domain Name Administrator** role):

1. Go to **Entra ID** → **Domain names**.
2. Click **Add custom domain**.
3. In **Custom domain name**, enter `handsfreeos.com`.
4. Click **Add domain**.
5. Copy the two values the page shows for the **TXT** record: the host (usually `@`) and the value (it starts with `MS=ms`).
6. At your DNS provider, add a new TXT record for `handsfreeos.com` with that host, that value, and a TTL of `3600`. Add it next to any TXT records already there; don't replace them.
7. Back in **Entra ID** → **Domain names**, click `handsfreeos.com`.
8. Click **Verify**.

   You should see `handsfreeos.com` marked as verified. DNS can take anywhere from minutes to a day; if it fails, wait an hour and click **Verify** again.

A domain can be verified in only one tenant. Add only the TXT record. If Microsoft 365 later suggests more records for this domain (such as MX), skip them unless you mean to receive `handsfreeos.com` mail in Microsoft 365.

Fill in the branding:

1. Go to **Entra ID** → **App registrations** → **HandsFreeOS**.
2. Click **Branding & properties** (on some screens just **Branding**).
3. Upload `design/brand/handsfreeos-icon.png` from this repository as the logo. If Entra refuses it as too large, run this from the repository folder to make a smaller copy on your Desktop, and upload that instead:

   ```bash
   sips -Z 215 design/brand/handsfreeos-icon.png --out ~/Desktop/handsfreeos-logo-215.png
   ```

4. In **Home page URL**, enter `https://handsfreeos.com`.
5. In **Terms of service URL**, enter `https://handsfreeos.com/terms`.
6. In **Privacy statement URL**, enter `https://handsfreeos.com/privacy`.
7. Click **Save**.
8. Under **Publisher domain**, click **Configure a domain** (or **Update domain**).
9. Choose **Select a verified domain**.
10. Pick `handsfreeos.com` and save.

    You should see **Publisher domain** show `handsfreeos.com`.

If you skipped adding the domain to the tenant, the other choice is **Verify a new domain**. It needs `https://handsfreeos.com/.well-known/microsoft-identity-association.json` to answer with `Content-Type: application/json` and the body `{"associatedApplications":[{"applicationId":"<Application (client) ID>"}]}`. Nothing in this repository serves that file, so the DNS route is easier. For publisher verification, the publisher domain can't be an `onmicrosoft.com` address.

#### Publisher verification

Until the app is publisher verified, Microsoft's consent screen shows **Unverified** where the publisher's name would be. Some business tenants don't let employees approve apps from unverified publishers, and Microsoft treats a new multitenant app that is not publisher verified, and asks for more than basic permissions, as risky. Verification shows the name with a blue verified badge instead. It is free, and so is the partner program it needs.

Enroll in the Microsoft AI Cloud Partner Program. The program has had several names; Partner Center may abbreviate it MAICPP. The person enrolling must be a **Global Administrator** of the tenant that holds the app and be allowed to sign agreements for the business. Partner Center's screens change often. If a label below has moved, look for the choice that enrolls a business as a partner, and search Partner Center for "Legal info" to find the verification pages.

Before you enroll, choose the email address Microsoft will verify. It must be a business mailbox you can read (not a free address such as Gmail), on `handsfreeos.com` or on a domain that is DNS-verified in the same tenant. The simplest choice is `chris@gobizhelp.com`:

1. Add `gobizhelp.com` to the tenant with the same steps you used for `handsfreeos.com` in "Branding and the publisher domain". Add the TXT record only, and don't change its MX records. If `gobizhelp.com` is already verified in this tenant (for example, Go Biz Help's own Microsoft 365), skip this step.

   You should see `gobizhelp.com` marked verified in **Entra ID** → **Domain names**.

2. Use `chris@gobizhelp.com` as the primary contact when you enroll.

If `gobizhelp.com` is already verified in another Microsoft tenant, it can't be added here. Either use that tenant for everything in this section, or create a mailbox on `handsfreeos.com`.

Also before you enroll, get the domain papers ready for the employment check:

1. Sign in to the registrar for the domain of your contact email.
2. Check that the registrant is the legal business name and address you will enter in Partner Center, spelled exactly the same. If the registrar shows you personally rather than the business, update it to the business first.
3. Download a registration record or invoice that shows the business name, address, domain, purchase date and expiry date. Save it for the employment check.

The consent screen will show this legal business name as the publisher.

Enroll:

1. Open `https://partner.microsoft.com/dashboard/account/v3/enrollment/introduction/partnership`.
2. Choose **Partner**.
3. Click **Next**.
4. Sign in with your work account in the tenant that holds the app. Don't use a personal Microsoft account.
5. Select the billing account for the legal business.
6. Read the Microsoft AI Cloud Partner Program agreement.
7. Tick the box to accept it.
8. Enter the legal business name and address exactly as they appear on your business registration documents.
9. Enter the contact email you chose above.
10. Submit the enrollment. If the wording differs, look for the button that submits or finishes it.

    You should see an email from Microsoft asking you to confirm the contact address.

11. In Partner Center, open **Account settings** → **Legal info** → **Verification Summary**.
12. On the **Contact Info** page in **Verification Summary**, enter the code from Microsoft's email. Check your junk folder, and add `microsoft.com` as a safe sender.
13. Complete identity verification with a government ID whose name matches your Partner Center user.
14. On the **Business Information** page, upload the domain registration document.
15. On the same page, upload your formation document or business license. Its name and address must match exactly.

    You should see the overall status on **Account settings** → **Legal info** change to **Authorized**, usually within three to five business days.

16. Open **Account settings** → **Identifiers**, then the **Microsoft AI Cloud Partner Program** tab.
17. Copy the **Partner Global Account (PGA)** Partner One ID into the "Microsoft Entra app" entry in your password manager. Use the PGA ID, not a location ID.

Mark the app as verified. You need **Application Administrator** or **Cloud Application Administrator** in Entra, and **Partner Admin** or **Account Admin** in Partner Center.

1. Sign in to `https://entra.microsoft.com` with multifactor authentication.
2. Go to **Entra ID** → **App registrations** → **HandsFreeOS** → **Branding & properties**.
3. Check that **Publisher domain** shows `handsfreeos.com`.
4. Near the bottom, click **Add Partner ID to verify publisher**.
5. Enter the PGA Partner One ID.
6. Click **Verify and save**.

   You should see a blue verified badge next to the publisher name after a few minutes. The consent screen can take longer to show it.

Publisher verification does not remove the need for an admin's approval at businesses whose settings require one.

#### Business clients: admin approval

Depending on a business's Microsoft consent settings, an employee who clicks **Connect Outlook** may see "Approval required" or "Need admin approval", or an error such as `AADSTS90094`, `AADSTS90095` or `AADSTS65001`. Back in HandsFreeOS the message reads "Sign-in cancelled. Nothing was connected." or "That mailbox didn’t connect. Try again in a minute.", and the mailbox may stay listed as **Connecting** until it is removed with the **X**. Personal Outlook.com and Hotmail accounts are not affected.

Why it happens: Microsoft's recommended consent setting ("Let Microsoft manage your consent settings"), the default for new tenants, stops ordinary users from approving `Mail.Read` and `Mail.ReadWrite`, and HandsFreeOS needs both. Other tenants limit user consent in their own ways, for example to apps from verified publishers only. Microsoft also requires an admin for a new multitenant app that is not publisher verified and asks for more than basic permissions: `AADSTS90094` when the tenant has no admin consent workflow, and `AADSTS90095` is the screen that tells the user to ask an admin when the tenant has that workflow. In all of these cases, the client's Microsoft 365 admin approves HandsFreeOS once. Microsoft is renaming these menus, so if a name differs, search the Entra admin center for "Enterprise apps".

- **The teammate sent a request.** If the client has turned on Microsoft's admin consent workflow, the employee can click **Request approval** on the blocked screen. The admin signs in at `https://entra.microsoft.com`, opens **Entra ID** → **Enterprise apps**, then under **Activity**, **Admin consent requests** → **My Pending**, selects HandsFreeOS, clicks **Review permissions and consent**, and accepts. This works only if the admin is a designated reviewer (at least **Cloud Application Administrator**). A reviewer can only act on requests made after they were designated. If the teammate saw no way to send a request, use one of the ways below.
- **The client's admin connects first.** This works when the client's **Global Administrator** (or **Privileged Role Administrator**) is also an owner or admin in their HandsFreeOS workspace. They click **Connect Outlook**, sign in, tick the box on Microsoft's consent screen that consents on behalf of their organization, and click **Accept**. The checkbox appears only for those two roles. This also connects the admin's own mailbox. If they don't want it connected, they can click the **X** next to it afterwards; the organization's approval stays.
- **Send the admin a link.** Send the client's admin `https://login.microsoftonline.com/organizations/adminconsent?client_id=<Application (client) ID>` (they can put their own tenant domain in place of `organizations`). The client ID is the value of `MICROSOFT_OAUTH_CLIENT_ID`; it is not a secret. They sign in and accept for their organization. Microsoft then sends them to HandsFreeOS, which shows a page titled "This sign-in link has expired". That page is expected here: the approval is already recorded, and employees can now connect.
- **Approve in their admin center.** An admin with the **Privileged Role Administrator**, **Cloud Application Administrator**, **Application Administrator** or **AI Administrator** role opens **Entra ID** → **Enterprise apps** → **All applications**, opens **HandsFreeOS**, clicks **Permissions** (under **Security**) and clicks **Grant admin consent**. HandsFreeOS may only be listed there after someone at the business has tried to connect; if it isn't, send the link instead.

After the approval, the teammate removes the stuck mailbox with the **X** and clicks **Connect Outlook** again.

You should see "Connected. Email with customers comes in over the next few minutes."

#### Test with a Microsoft 365 account

Repeat the Outlook test with a work account in a Microsoft 365 tenant, such as Go Biz Help's own.

1. Open **Settings** → **Email**.
2. Click **Connect Outlook**.
3. Sign in with the Microsoft 365 work account.
4. If Microsoft says an admin must approve, have that tenant's admin approve HandsFreeOS in one of the ways above, then start again at step 1.
5. On the consent screen, click **Accept**.

   You should see a row for the work account with the badge **Connected**.

6. Repeat steps 11 to 16 of "Test Outlook with a personal account" with this account.
7. Optional: repeat step 17 there, removing HandsFreeOS at `https://myapps.microsoft.com`.

### Google (Gmail)

Google moved its old **APIs & Services** → **OAuth consent screen** page into the **Google Auth platform**, with pages such as **Overview**, **Branding**, **Audience**, **Clients**, **Data Access** and **Verification Center**. If a menu below has moved, search the Cloud console for the page name.

This is the Gmail client. Sign in with Google to HandsFreeOS itself uses a separate client in a separate project (see "Sign in with Google" in "The database: Supabase (hosted)").

#### Create the project and turn on the Gmail API

1. Open `https://console.cloud.google.com` and sign in with the Google account that will own the project. Google sends its review emails to the project's owners and editors, starting with this account, so pick one you will keep (one on `handsfreeos.com` if you have it).
2. If this is your first time in Google Cloud, pick your country, tick the box to agree to the Terms of Service, and continue.
3. Open the project picker in the top bar.
4. Click **New project**.
5. In **Project name**, enter `HandsFreeOS`.
6. Click **Create**.
7. Select the new project in the project picker.
8. Open the menu and go to **APIs & Services** → **Library**.
9. Search for `Gmail API` and open it.
10. Click **Enable**.

    You should see the Gmail API's page showing it as enabled.

Turn the API on before the Data Access step; until it is on, the Gmail scopes don't show in the scope picker. The Gmail API is the only Google API HandsFreeOS uses. There is no Pub/Sub topic to create: the worker checks Gmail every two minutes.

#### Set up the Google Auth platform

1. Open the menu and go to **Google Auth platform** → **Branding** (or open `https://console.cloud.google.com/auth/overview`).
2. Click **Get started**.
3. Under **App Information**, enter `HandsFreeOS` in **App name**.
4. In **User support email**, pick your address.
5. Click **Next**.
6. Under **Audience**, choose **External**. (**Internal** only works for people in your own Google Workspace.)
7. Click **Next**.
8. Under **Contact Information**, enter an email address Google can reach you at.
9. Click **Next**.
10. Under **Finish**, tick the box to agree to the **Google API Services: User Data Policy**.
11. Click **Continue**.
12. Click **Create**.

    You should see the Google Auth platform's **Overview** page for HandsFreeOS.

#### Verify the domain and fill in Branding

Google requires every domain on the consent screen to be verified in Google Search Console, by a Google account that is an **Owner** or **Editor** on the project.

1. Open `https://search.google.com/search-console` with that account.
2. Click **Add property**. If the menu has moved, look for the option to add a new property.
3. Under **Domain**, enter `handsfreeos.com`.
4. Click **Continue**.
5. Copy the TXT value that starts with `google-site-verification=`.
6. At your DNS provider, add a new TXT record with host `@` and that value. Keep every TXT record already there, including Microsoft's `MS=` record and any SPF record.
7. Back in Search Console, click **Verify**.

   You should see `handsfreeos.com` listed as a verified property.

Then fill in Branding:

1. Go to **Google Auth platform** → **Branding**.
2. Check that **App name** is `HandsFreeOS` and **User support email** is right.
3. Upload `design/brand/handsfreeos-icon.png` from this repository as the **App logo**. It must be square, JPG, PNG or BMP, and 1 MB or less; Google recommends 120 by 120 pixels.
4. In **Application home page**, enter `https://handsfreeos.com`. It must be public and describe HandsFreeOS.
5. In **Application privacy policy link**, enter `https://handsfreeos.com/privacy`. It must say how Google user data is accessed, used, stored and shared (see "Before you start" in this section).
6. In **Application terms of service link**, enter `https://handsfreeos.com/terms`.
7. Under **Authorized domains**, click **Add domain**.
8. Enter `handsfreeos.com`. That also covers `hooks.handsfreeos.com`.
9. Under **Developer contact information**, enter your email address.
10. Click **Save**.

    You should see the Branding page keep your values after a reload.

#### Add the Gmail scopes (Data Access)

1. Go to **Google Auth platform** → **Data Access**.
2. Click **Add or remove scopes**.
3. Filter the list for Gmail and tick `https://www.googleapis.com/auth/gmail.readonly`.
4. Tick `https://www.googleapis.com/auth/gmail.send`.
5. If either is missing from the list, paste its full address into **Manually add scopes** and add it to the table.
6. Click **Update**.
7. Click **Save** on the Data Access page.

   You should see `gmail.readonly` under the restricted scopes and `gmail.send` under the sensitive scopes.

These are the only two scopes the worker asks for (`apps/worker/src/mailbox/gmail.ts`), and it refuses a connection unless both were granted. Don't add `gmail.modify` or `https://mail.google.com/`: both are restricted too and widen Google's review. Don't add `openid`, `email` or `profile` either; the worker reads the address from the Gmail profile.

#### Add test users (Audience)

1. Go to **Google Auth platform** → **Audience**.
2. Check that **Publishing status** is **Testing** and **User type** is **External**.
3. Under **Test users**, click **Add users**.
4. Enter your own Gmail address, and any others who will test.
5. Click **Save**.

   You should see the addresses under **Test users**.

While the app is in Testing:

- There can be at most 100 test users, and each address counts as soon as it is added.
- Only test users can connect. Google blocks everyone else.
- Each Gmail sign-in lapses seven days after the person approves it. HandsFreeOS then marks the mailbox **Needs reconnecting** and emails the person who connected it, so expect a "Reconnect your Gmail mailbox" email every week until Google approves the app.

#### Create the OAuth client (Clients)

1. Go to **Google Auth platform** → **Clients** (or open `https://console.cloud.google.com/auth/clients`).
2. Click **Create client**.
3. In **Application type**, choose **Web application**.
4. In **Name**, enter `HandsFreeOS worker`. Only you see this name.
5. Leave **Authorized JavaScript origins** empty.
6. Under **Authorized redirect URIs**, click **Add URI**.
7. Enter exactly `https://hooks.handsfreeos.com/oauth/google/callback`.
8. Click **Create**.

   You should see a window with the new client's **Client ID** and **Client secret**. Don't close it until both are in your password manager.

9. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) into a new password manager entry named "Google Gmail client". This is `GOOGLE_OAUTH_CLIENT_ID`.
10. Copy the **Client secret** (it starts with `GOCSPX-`) into the same entry. This is `GOOGLE_OAUTH_CLIENT_SECRET`. Google shows the full secret only now; afterwards the console shows only its last few characters. Never commit it or paste it into a file in this repository.
11. If you download the JSON file as a backup, attach it to the password manager entry, then delete it from your Downloads folder. Never save it inside this repository.

If the redirect URI doesn't match exactly, Google stops the sign-in with `redirect_uri_mismatch`.

Google deletes an OAuth client that has had no activity for six months, with an email 30 days before. That only matters if Gmail sits unused for a long time.

Don't reuse this client for `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in the root `.env.example`. Those are for Sign in with Google to HandsFreeOS itself (switched off until you set it up), which needs its own client and redirect.

#### Give the worker the Google values

1. Start an import on the worker.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

2. Paste these two lines, with the values from your password manager, then press Return and Control-D. Fly restarts the worker with them.

   ```text
   GOOGLE_OAUTH_CLIENT_ID=<Google client ID>
   GOOGLE_OAUTH_CLIENT_SECRET=<Google client secret>
   ```

   You should see the command finish without an error.

3. List the worker's secrets.

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   You should see `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the `NAME` column.

This does not turn on Connect Gmail. The **Connect Gmail** button stays greyed out in the web app until the web build has `NEXT_PUBLIC_GMAIL_ENABLED=true` (next part).

#### Test Gmail while Google's review is pending

The worker doesn't check whether Google has approved the app, but the web app keeps **Connect Gmail** greyed out, with the badge "Waiting on Google’s review", until it is built with `NEXT_PUBLIC_GMAIL_ENABLED=true`. The flag turns Connect Gmail on for every user; there is no per-person switch. To test before approval, turn the flag on for a short while. Only your test users can get past Google's sign-in, so do this only while no clients use HandsFreeOS.

1. In Vercel, edit `NEXT_PUBLIC_GMAIL_ENABLED` and set it to `true` for **Production** (see "Environment variables" in "The web app on Vercel"). Enter `true` in lower case. Any other value, such as `True`, `1` or `yes`, leaves Gmail off.
2. Redeploy with "Redeploy after a change" in "The web app on Vercel".

   You should see the deployment finish as **Ready**, and **Settings** → **Email** show **Connect Gmail** without the "Waiting on Google’s review" badge.

Then test with a test-user account:

1. If you haven't already, add the customer in **Customers** as in the Outlook test.
2. Open **Settings** → **Email**.
3. Click **Connect Gmail**.
4. Sign in with a Gmail address you added as a test user.
5. Google warns that it hasn't verified the app. As a test user, click **Continue**. If you see **Advanced** instead, click **Advanced**, then click the link that goes on to HandsFreeOS.
6. On the consent screen, leave both Gmail permissions ticked (if there are checkboxes, tick both or **Select all**).
7. Click **Continue**.

   You should see "Connected. Email with customers comes in over the next few minutes." and a row for the address with the badge **Connected**.

8. From the customer's address, send an email to the Gmail address.

   You should see it in the HandsFreeOS **Inbox** within about two minutes.

9. Open that conversation in the **Inbox**.
10. Write a reply and choose `From <address> (Gmail)` as the sender.
11. Send the reply.

    You should see the reply arrive at the customer's address in the same thread, and a copy in the Gmail account's **Sent** folder.

To close Gmail again after the test:

1. In Vercel, edit `NEXT_PUBLIC_GMAIL_ENABLED` and change the value to `false`.
2. Click **Save**.
3. Redeploy with "Redeploy after a change" in "The web app on Vercel".

   You should see **Connect Gmail** greyed out again, with the "Waiting on Google’s review" badge.

A mailbox that is already connected keeps syncing, and its **Reconnect** button keeps working, because the flag only controls the **Connect Gmail** button.

#### Restricted-scope verification and the CASA assessment

`gmail.readonly` is a restricted scope (`gmail.send` on its own would only be sensitive). A server that reads restricted Gmail data must pass Google's restricted-scope verification, which includes a CASA security assessment. Apps in Testing don't need verification, which is why the test above works. Google's policy lists customer relationship management among the allowed uses of Gmail restricted scopes.

CASA is the Cloud Application Security Assessment: a security review of how HandsFreeOS handles Google data, done by an independent lab that Google has authorized, under the App Defense Alliance's framework. Google decides the level (currently AL1 or AL2; some Google pages still say Tier 2 and Tier 3). At both levels an authorized lab does the testing and validation. AL2 is broader: the lab checks every CASA requirement across the app, the servers it runs on and wherever user data is stored. You pay the lab; Google charges nothing. Google requires reverification and a new security assessment at least every 12 months after the lab's letter is approved (Google calls it the Letter of Assessment; labs such as TAC Security call it the Letter of Validation). Google emails you when it is due.

Cost and time, as rough planning figures. Google doesn't publish prices; these come from the labs and may have changed.

- Lab fee: TAC Security lists AL1 at $675 (Basic) or $855 (Premium) per application as a one-time assessment; Basic includes 2 revalidations and Premium unlimited. Its yearly Enterprise plans are $4,500 for AL1 and $5,400 for AL2. Your level isn't known until Google assigns it.
- Lab work: TAC quotes 2 to 3 weeks from assessment to letter for AL1 (1 to 2 weeks on Enterprise) and 2 to 4 weeks for AL2.
- Brand verification: minutes, or two to three business days if Google reviews it by hand.
- The whole restricted-scope review: Google says restricted-scope verification can take several weeks, plus the lab's CASA work. Plan on two to three months from submission to approval (this guide's planning figure, not Google's).

Have these ready before you submit:

- `handsfreeos.com` verified in Search Console, and Branding complete.
- A public home page at `https://handsfreeos.com` that describes HandsFreeOS.
- A privacy policy at `https://handsfreeos.com/privacy` that covers Google user data and says HandsFreeOS follows Google's Limited Use requirements: the data is used only to provide features people can see in HandsFreeOS, and is not used for ads or sold.
- A demo video in English, usually an unlisted YouTube link. It shows the whole Connect Gmail sign-in with the client ID visible in the browser's address bar, then an email with a customer arriving in the HandsFreeOS inbox, then a reply being sent. Record it while you do "Test Gmail while Google's review is pending" (Stage 8 of the go-live checklist).
- A short reason for each scope. For example: `gmail.readonly` brings email exchanged with the business's existing customers into their record and the team inbox (everything else is skipped and never stored), and `gmail.send` sends the replies a teammate writes in HandsFreeOS from their own address.

Submit:

1. Go to **Google Auth platform** → **Branding**.
2. Click **Verify branding**.
3. When it passes, click **Publish branding** within seven days.
4. Go to **Google Auth platform** → **Audience**.
5. Click **Publish app**.
6. Confirm in the window that opens.

   You should see **Publishing status** change to **In production**. That ends the seven-day sign-in lapse, but until Google approves, people see an unverified-app warning and at most 100 new users can connect in total. Keep **Connect Gmail** off for clients.

7. Open **Verification Center** (`https://console.cloud.google.com/auth/verification`).
8. Click **Prepare for verification**.
9. Review the details and click **Save and Continue**.
10. Enter the scope reasons and the video link.
11. Click **Submit for verification**.

    You should see an email from Google to the project's owners and editors about the submission.

12. Wait for Google's OAuth review team to email the project's owners and editors that it is time to start the security assessment. You can't start CASA before Google assigns the level.
13. Choose one of the authorized labs listed in Google's email (such as TAC Security, Leviathan Security, NCC Group or Bishop Fox).
14. Sign up with the lab and pay its fee.
15. Give the lab what it asks for: access to the running app, documents, or scan results.
16. Fix what the lab finds.
17. Get the lab's letter. Google's review then continues.

    You should see an approval email from Google when verification is done.

18. Put the reassessment date (12 months after Google approves the lab's letter) in your calendar. Google also emails you when it is due.

#### Turn Gmail on for everyone

After Google approves:

1. In Vercel, set `NEXT_PUBLIC_GMAIL_ENABLED` to `true` (edit it if it is listed; add it if not), with the steps in "Environment variables" in "The web app on Vercel".
2. Click **Save**.
3. Redeploy with "Redeploy after a change" in "The web app on Vercel".

   You should see **Connect Gmail** available in **Settings** → **Email** for every workspace, without the "Waiting on Google’s review" badge.

### When a sign-in stops working

A connected mailbox loses access when, for example:

- the person changes or resets their password,
- the person, or their admin, removes HandsFreeOS from their Microsoft or Google account,
- Google's seven-day limit runs out (Gmail, while the app is in Testing).

What HandsFreeOS does:

- The worker notices the next time it renews the sign-in (a few minutes before the current access runs out) or when Microsoft or Google turns a request down. Access lasts about an hour (up to about 90 minutes for Microsoft work accounts), so expect it within an hour and a half.
- The mailbox's badge in **Settings** → **Email** changes to **Needs reconnecting**, with "lost access after" and the date. The worker stops checking that mailbox.
- The person who connected the mailbox gets one email from the worker's `MAIL_FROM` address, titled "Reconnect your Outlook mailbox" or "Reconnect your Gmail mailbox". It says HandsFreeOS lost access on that date, has a **Reconnect Outlook** or **Reconnect Gmail** button that opens **Settings** → **Email**, and ends with "Nothing was lost. Mail from the gap comes in once you reconnect." It is sent once per lapse, not repeatedly. If that person's account no longer exists, every owner and admin of the workspace gets it instead.
- The mailbox disappears from the **From** choices in the **Inbox** until it is reconnected, so replies go from the workspace address. A reply that was already on its way fails with "Outlook isn’t connected anymore. Reconnect it in Settings → Email, or send from the workspace address." If the lapse is found during the send itself, the reply fails with "Outlook needs <account> to sign in again. Reconnect it in Settings → Email, then try again." (Gmail messages read the same with Gmail.)

To fix it, the person (who must be an owner or admin) opens **Settings** → **Email**, clicks **Reconnect** next to the mailbox, and signs in with the same account. **Reconnect** works even while **Connect Gmail** is greyed out. Reconnecting makes a fresh connection, retires the old one (its row leaves the list), and starts a check right away. The first check looks back 30 days from the reconnect (`MAILBOX_BACKFILL_DAYS` on the worker, 1 to 90), so mail from the gap comes in as long as the gap was shorter than that.

Other problems look different:

- **Not syncing.** Network errors, Microsoft or Google outages and throttling are retried, waiting longer each time (up to 30 minutes). After five failed checks in a row, the badge shows **Not syncing** with the last error. Nobody is emailed for this. The worker keeps trying, and the badge goes back to **Connected** after the next good check. While it shows **Not syncing**, the mailbox is also missing from the **From** choices.
- **An expired or wrong client secret.** Microsoft or Google answers `invalid_client`. HandsFreeOS treats that as a server problem, not a lost sign-in. After five failed checks, every mailbox of that provider shows **Not syncing** with "Microsoft refused the sign-in (invalid_client)." (or "Google refused the sign-in (<code>)"). Nobody is emailed, and **Reconnect** doesn't help. Setting a new secret on the worker fixes it (see "Rotating the client secrets"); the mailboxes recover on their next check, usually within about 30 minutes.
- **A lost `WORKER_ENCRYPTION_KEY`.** The stored sign-ins are sealed with it, so without it every mailbox must be reconnected.

What the badges mean:

| Badge                  | Meaning                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Connected**          | Checking normally; the line under the address says when it last synced.                                |
| **Connecting**         | A sign-in has started and hasn't finished. The row disappears after ten minutes if nobody finishes it. |
| **Needs reconnecting** | Microsoft or Google stopped accepting the sign-in. The person clicks **Reconnect**.                    |
| **Not syncing**        | Five checks in a row failed. The line under the address shows the last error.                          |

The **X** next to a mailbox disconnects it. HandsFreeOS deletes its stored sign-in and stops checking, the web app says "<account> disconnected. Email already brought in stays.", and the mailbox's row disappears from the list. It doesn't remove HandsFreeOS from the person's Microsoft or Google account; they can do that in their account's app permissions (for Google, `https://myaccount.google.com/permissions`). An Outlook mailbox's notifications stop on their own within three days.

### When a connection fails

| What you see                                                                                    | Why                                                                                                                                                                               | What to do                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect opens a page at `127.0.0.1` that doesn't load                                           | Vercel has no `NEXT_PUBLIC_WORKER_URL`                                                                                                                                            | Set it to `https://hooks.handsfreeos.com` for Production and redeploy (see "The web app on Vercel")                                                                                                                                                                       |
| A HandsFreeOS page "Outlook isn’t set up yet" or "Gmail isn’t set up yet"                       | The worker is missing that provider's client ID or secret                                                                                                                         | Set both on `handsfreeos-worker` ("Give the worker the Microsoft values" or "Give the worker the Google values")                                                                                                                                                          |
| A HandsFreeOS page "This sign-in link has expired"                                              | More than ten minutes passed, or the link was used before. It also appears after a Microsoft admin approves HandsFreeOS through an admin consent link; the approval still counts. | Go back to **Settings** → **Email** and connect again                                                                                                                                                                                                                     |
| Microsoft error `AADSTS50011`                                                                   | The redirect URI in Entra doesn't match                                                                                                                                           | Set it to `https://hooks.handsfreeos.com/oauth/microsoft/callback` on the **Web** platform                                                                                                                                                                                |
| Microsoft error `AADSTS50194`                                                                   | The Entra app isn't multitenant                                                                                                                                                   | In **Entra ID** → **App registrations** → **HandsFreeOS** → **Authentication** (or **Manifest**), set the supported account types to any Entra ID tenant plus personal Microsoft accounts. If the setting has moved, search the app's pages for "Supported account types" |
| Microsoft says an admin must approve, or error `AADSTS90094`, `AADSTS90095` or `AADSTS65001`    | The client's tenant blocks employees from approving mail access                                                                                                                   | See "Business clients: admin approval"                                                                                                                                                                                                                                    |
| Google error `redirect_uri_mismatch`                                                            | The redirect URI on the Google client doesn't match                                                                                                                               | Set it to `https://hooks.handsfreeos.com/oauth/google/callback`                                                                                                                                                                                                           |
| Google blocks the sign-in                                                                       | The app is in Testing and the account isn't a test user                                                                                                                           | Add the address under **Audience** → **Test users**                                                                                                                                                                                                                       |
| "HandsFreeOS needs permission to read and send mail. Connect again and leave every box ticked." | A permission was unticked on the consent screen                                                                                                                                   | Connect again and leave every box ticked                                                                                                                                                                                                                                  |
| "Sign-in cancelled. Nothing was connected."                                                     | The person cancelled or declined, or an admin's approval is needed                                                                                                                | Connect again if they want to; for business accounts, see "Business clients: admin approval"                                                                                                                                                                              |
| "That mailbox didn’t connect. Try again in a minute."                                           | The worker couldn't finish the sign-in                                                                                                                                            | Check `fly logs --app handsfreeos-worker` for `a mailbox did not connect` and the reason after it. If there is no such line, see below                                                                                                                                    |

Not every failed sign-in leaves a log line. If the log has no `a mailbox did not connect` line, Microsoft or Google itself returned an error (the browser's address bar briefly showed `error=...` on the `/oauth/<provider>/callback` address). The worker saves the reason on the mailbox's row, but **Settings** → **Email** shows only "connecting…" for that row, and the row goes away after ten minutes. Check the redirect URI, the account type (Microsoft) or the test users (Google), then connect again.

### Rotating the client secrets

Microsoft, before the date in your calendar:

1. In the Entra app, open **Certificates & secrets** → **Client secrets**.
2. Click **New client secret**.
3. In **Expires**, choose the longest option, the one that ends in **(24 months)**.
4. Click **Add**.
5. Copy the new **Value** (not the **Secret ID**) into the "Microsoft Entra app" entry in your password manager. Never commit it.
6. Start an import on the worker.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

7. Paste `MICROSOFT_OAUTH_CLIENT_SECRET=<new Microsoft client secret value>`, then press Return and Control-D.
8. Wait two hours, so every mailbox renews its sign-in with the new secret.
9. Open the worker's log.

   ```bash
   fly logs --app handsfreeos-worker
   ```

   You should see no `mailbox sync failed` line that mentions `invalid_client`. Press Control-C to stop the log.

10. Open **Settings** → **Email** in a workspace with an Outlook mailbox.

    You should see the mailbox still **Connected**, with a "synced" time from the last few minutes.

11. Only now delete the old secret in the Entra app.
12. Move the calendar reminder to the new expiry date.

If the old secret has already expired, skip the wait: set the new one at once, and the mailboxes return to **Connected** on their next check.

Google, whenever you rotate (a client can hold two secrets at once):

1. Go to **Google Auth platform** → **Clients**.
2. Open **HandsFreeOS worker**.
3. Click **Add Secret**.
4. Copy the new secret into the "Google Gmail client" entry in your password manager. Never commit it.
5. Start an import on the worker.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

6. Paste `GOOGLE_OAUTH_CLIENT_SECRET=<new Google client secret>`, then press Return and Control-D.
7. Wait two hours.
8. Open **Settings** → **Email** in a workspace with a Gmail mailbox.

   You should see the mailbox still **Connected**, with a "synced" time from the last few minutes.

9. Next to the old secret, click **Disable**.
10. After a day with no problems, delete the disabled secret.

### Good to know

- **Outlook pushes, Gmail is polled.** Outlook tells the worker about new mail within a minute; the worker also checks every five minutes in case a notification goes missing. Gmail is checked every two minutes.
- **Only mail with customers is kept.** A mailbox's mail is stored only when the other party is a person in Customers or someone the workspace already has an email conversation with. Gmail's automatic mail (auto-replies and bulk mail) is skipped. Outlook doesn't give the worker the headers that mark automatic mail, so an automatic reply from a customer's address is kept. Everything else is never stored, not even attachments, and it doesn't wait under **Mail from people not in Customers** (that list is only for replies to the workspace address).
- **A new mailbox looks back 30 days.** Its first check brings in the last 30 days of mail with customers.
- **Every mailbox is personal today.** The code can mark a mailbox as shared (such as `info@`), which would send the reconnect email to every owner and admin, but no screen sets that yet.
- **There is no Sync now button yet.** The API has the command, but **Settings** → **Email** doesn't show it.
- **Locally, nothing reaches Microsoft or Google.** Without the client IDs, Connect Outlook opens a stand-in sign-in page on the worker, and the mailboxes live in memory (see "The mailbox stand-in (Outlook and Gmail)" in "Local development"). `pnpm env:local` writes no mailbox values, so local mailboxes stay fake. The automated tests for connecting, syncing, sending and losing access use those fake mailboxes and need the local Supabase stack running, with `pnpm env:local` done (see "First-time setup" in "Local development"). Run the mailbox tests:

  ```bash
  pnpm --filter @hfos/worker test mailbox
  ```

  You should see `mailbox.test.ts` and `mailbox-providers.test.ts` pass.

## Local development

This section runs all of HandsFreeOS on your Mac: the web app, the API, the worker, and a private copy of Supabase in Docker. It never touches the hosted Supabase project. By default nothing reaches Twilio, Postmark, Microsoft or Google either. The worker uses stand-ins for all of them, so nothing costs money and no phone is needed. The last part of this section explains how to swap one stand-in for the real provider when you need to.

Run every command in Terminal from the repository folder unless a step says otherwise:

```bash
cd ~/Projects/HandsFreeOS
```

### What you need first

You need Homebrew, Node 22 (22.12 or later), pnpm 12, Docker and the Supabase CLI. Check each one and install only what is missing.

1. Check Homebrew.

   ```bash
   brew --version
   ```

   You should see a line that starts with `Homebrew`. If you see `command not found`, install Homebrew from `https://brew.sh` and run the lines it prints under **Next steps**.

2. Check Node.

   ```bash
   node --version
   ```

   You should see `v22.12.0` or a later `v22` version. The repository asks for Node 22 in `.nvmrc` and for 22.12 or later in `package.json`. If Node is missing or older, install it:

   ```bash
   brew install node@22
   ```

   If Homebrew then prints lines that add Node to your PATH, run them and open a new Terminal window. In the new window, go back to the repository folder:

   ```bash
   cd ~/Projects/HandsFreeOS
   ```

   Then check again:

   ```bash
   node --version
   ```

   You should see `v22.12.0` or a later `v22` version.

3. Check pnpm.

   ```bash
   pnpm --version
   ```

   You should see `12.3.4` or another `12.x` version. The repository pins pnpm 12.3.4 in `package.json`. If you see `command not found`, install it:

   ```bash
   brew install pnpm
   ```

   If you see an older version, update it and run the check again:

   ```bash
   brew upgrade pnpm
   ```

4. Check the Supabase CLI.

   ```bash
   supabase --version
   ```

   You should see `2.117.0` or later. That is the version CI uses. If you see `command not found`, install it:

   ```bash
   brew install supabase/tap/supabase
   ```

   An older CLI may reject `supabase/config.toml`. If your version is older, update it:

   ```bash
   brew upgrade supabase
   ```

5. Install Colima and the Docker command-line tool. If you prefer Docker Desktop, download it from `https://www.docker.com/products/docker-desktop/`, open it, and wait until it shows that it is running. Then skip this step and the next two.

   ```bash
   brew install colima docker
   ```

6. Start Colima with 4 CPUs and 8 GB of memory.

   ```bash
   colima start --cpu 4 --memory 8
   ```

7. Check Colima.

   ```bash
   colima status
   ```

   You should see a line that contains `colima is running`.

Good to know about Docker:

- Colima does not start on its own after your Mac restarts. Start it before you start Supabase. It reuses the CPU and memory settings from the first start.

  ```bash
  colima start
  ```

- The `pnpm supabase:*` scripts and `pnpm env:local` find Colima's socket (`~/.colima/default/docker.sock`) for you. If you ever run `supabase` directly instead of through `pnpm`, tell it where Docker is first:

  ```bash
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  ```

### First-time setup

Do these once, in order.

1. Install the project's dependencies.

   ```bash
   pnpm install
   ```

   You should see pnpm finish without errors.

2. Start the local Supabase stack: Postgres, Auth, Realtime, Storage, Studio and Mailpit.

   ```bash
   pnpm supabase:start
   ```

   The first run downloads the Docker images and can take several minutes. If the two private files below do not exist yet, it also creates them and prints one line for each. If they already exist, it leaves them alone and prints nothing about them. Git ignores both.

   - `.env` at the repository root, copied from `.env.example`. It prints `Created .env from .env.example (Google OAuth values stay empty until you fill them in).` Only the Supabase CLI reads this file, for the optional Google sign-in described later in this section.
   - `supabase/signing_keys.json`, the key the local stack signs sign-in tokens with. It prints `Generating a local ES256 signing key: supabase/signing_keys.json (gitignored).` Never share or commit this file.

   You should see a summary of local addresses and keys when it finishes. You do not need to copy anything from it; the next step does that.

3. Write the local settings files.

   ```bash
   pnpm env:local
   ```

   You should see four lines: `wrote .env.local (11 vars)`, `wrote apps/api/.env (6 vars)`, `wrote apps/worker/.env (14 vars)` and `wrote apps/web/.env.local (5 vars)`.

   | File                  | Read by                                   | What is in it                                                                               |
   | --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
   | `.env.local`          | The tests, the seed and the browser tests | Everything, including the local Supabase secret key                                         |
   | `apps/api/.env`       | The API                                   | API settings. Never a secret key: the API refuses to start with one.                        |
   | `apps/worker/.env`    | The worker, and the browser tests' worker | Worker settings, the local secret key, the stand-ins, and the worker's local encryption key |
   | `apps/web/.env.local` | The web app                               | Publishable values only                                                                     |

   Each file starts with a comment saying it was generated and must not be committed, and Git ignores all four. Their values only work against the local stack.

   `pnpm env:local` rewrites all four files from scratch every time you run it. The one value it keeps is `WORKER_ENCRYPTION_KEY` in `apps/worker/.env`. The worker seals carrier and mailbox credentials with that key and needs the same key to open them later. Any line you added to these files by hand is gone after the next run, so add it back afterwards.

4. Fill the database with demo data.

   ```bash
   WORKER_ENCRYPTION_KEY="$(sed -n 's/^WORKER_ENCRYPTION_KEY=//p' apps/worker/.env)" pnpm db:seed
   ```

   The seed does not read `apps/worker/.env`, so the first part of the command hands it the worker's local encryption key, for this one command only. Without it, the seed seals Lone Star's stand-in carrier credentials with a throwaway key, and texting or calling from Lone Star's number then fails under `pnpm dev`. Plain `pnpm db:seed` works for everything else. Never `export` this variable in your shell: the API refuses to start while it is set.

   The seed creates the accounts through Supabase Auth and makes every change through the same command pipeline the app uses. Invitation emails go through Mailpit, and the seed accepts them from the emailed links, so the stack from step 2 must be running.

   You should see `Seeded in <n>s. Sign in at http://localhost:3000/sign-in with password HandsFree-Demo-2026:` followed by the list of accounts and the Mailpit address.

   Running the seed a second time changes nothing. It prints ``Seed data is already present (chris@gobizhelp.test exists). Run `pnpm db:reset` to start from scratch.``

Never run `pnpm db:seed`, `pnpm db:reset`, `pnpm env:local` or `pnpm test:e2e` against the hosted project. They expect Mailpit, the local Supabase stack and the stand-ins.

### Running everything

1. If your Mac restarted since last time, start Docker. (With Docker Desktop, open it instead.)

   ```bash
   colima start
   ```

2. Check whether the Supabase stack is running.

   ```bash
   pnpm supabase:status
   ```

   If it lists the local addresses, the stack is running. If it prints an error instead, start it:

   ```bash
   pnpm supabase:start
   ```

3. Start the web app, the API and the worker together.

   ```bash
   pnpm dev
   ```

   Each one reloads when its code changes. Leave this window open: it shows the logs of all three.

   You should see `OpenAPI at http://127.0.0.1:4000/docs` from the API, and a `worker started` line from the worker followed by `telephony: "fake"`, `email: "smtp"` and `mailboxes: "fake"`. That line always tells you which providers the worker is using. Check it after every change to `apps/worker/.env`.

4. Open `http://localhost:3000/sign-in` in your browser. Use `localhost`, not `127.0.0.1`: locally, passkeys only work on `localhost`.

   You should see the HandsFreeOS sign-in page.

5. Optional: check the API from Terminal.

   ```bash
   curl http://127.0.0.1:4000/healthz
   ```

   You should see a line that starts with `{"ok":true,"service":"api"` and ends with the current time.

6. Optional: check the worker the same way.

   ```bash
   curl http://127.0.0.1:4100/healthz
   ```

   You should see `{"ok":true}`.

Local addresses:

| What                  | Address                  | Notes                                                                                 |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| Web app               | `http://localhost:3000`  | Sign in at `/sign-in`                                                                 |
| API                   | `http://127.0.0.1:4000`  | API docs at `/docs`, health check at `/healthz`                                       |
| Worker                | `http://127.0.0.1:4100`  | Webhooks, voice tokens, number search and mailbox sign-in. Health check at `/healthz` |
| Supabase API and Auth | `http://127.0.0.1:54421` |                                                                                       |
| Supabase Studio       | `http://127.0.0.1:54423` | Browse tables, users and stored files                                                 |
| Mailpit               | `http://127.0.0.1:54424` | Every email the local stack sends                                                     |
| Postgres              | `127.0.0.1:54422`        | The apps connect as `hfos_api` and `hfos_worker`, never as `postgres`                 |
| Mailpit SMTP          | `127.0.0.1:54425`        | The worker's `SMTP_URL`                                                               |

Studio and Mailpit also answer on `localhost`. The local stack uses ports 54420 to 54429, so it does not collide with other Supabase projects on the default 543xx ports.

Local sign-in follows the same rules as the hosted project: passwords need at least 12 characters, new accounts confirm their email first, and passkeys are on. Confirmation emails (`Confirm your HandsFreeOS email`), password resets (`Reset your HandsFreeOS password`) and email changes (`Confirm your new HandsFreeOS email`) all land in Mailpit.

### Seeded accounts

Every seeded account uses the password `HandsFree-Demo-2026`. They exist only in your local database.

| Account                        | Name             | Role                                                                                  |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| `chris@gobizhelp.test`         | Chris Demo       | Owner of the Go Biz Help agency organization. Reaches every client workspace.         |
| `dale@lonestarhvac.test`       | Dale Ramsey      | Owner of Lone Star HVAC & Roofing                                                     |
| `priya@lonestarhvac.test`      | Priya Natarajan  | Admin of Lone Star HVAC & Roofing                                                     |
| `marco@lonestarhvac.test`      | Marco Villanueva | Member of Lone Star HVAC & Roofing (invited as admin, then changed to member by Dale) |
| `renee@bayouplumbing.test`     | Renée Fontenot   | Owner of Bayou Plumbing Co.                                                           |
| `tom@summitroofing.test`       | Tom Whitaker     | Owner of Summit Roofing                                                               |
| `riley@northstarelectric.test` | Riley Chen       | Owner of Northstar Electric, a separate organization that sees nothing of Go Biz Help |

What else the seed sets up:

- **Lone Star HVAC & Roofing** has the most data: about thirty customers, two pipelines, twenty leads, tasks, notes and two photos. It also has the toll-free business number `+18335550100`, bought from the fake carrier with texting approved, plus conversations (texts, email, an unknown number and a STOP) and calls, including a voicemail with its transcript.
- **One invitation is still pending,** for `jordan@lonestarhvac.test` (member, invited by Priya). Open its email in Mailpit to walk through accepting an invitation.
- **Time zones:** Lone Star and Bayou Plumbing use `America/Chicago`, Summit Roofing uses `America/Denver`, and Northstar Electric uses `America/Los_Angeles`.

### What the stand-ins do

The `worker started` line names the three stand-ins: `telephony: "fake"` (the fake carrier), `email: "smtp"` (Mailpit) and `mailboxes: "fake"` (the mailbox stand-in). Production refuses the fake carrier and the mailbox stand-in.

#### The fake carrier (texts and calls)

The worker uses the fake carrier whenever `TELEPHONY_PROVIDER` is `fake` or not set, and `pnpm env:local` writes `fake`. Buying a number, carrier approval, sending, delivery receipts and call setup all happen in memory inside the worker, so nothing costs money and no phone is needed.

- **Finding a number.** In **Settings** → **Texting & calls**, **Show numbers** lists up to six made-up numbers shaped like `+1<area code>555<four digits>`: toll-free area codes 833, 844, 855 and 877, or Houston (713) for local numbers unless you type another area code.
- **Buying.** The fake carrier turns down any number that ends in `0000` with "That number is no longer available." **Show numbers** never lists one, so only the automated tests show this error.
- **Carrier approval** arrives 3 seconds after you click **Submit for approval** on the business details step (`FAKE_APPROVAL_MS=3000`). A **Legal business name** that contains `reject` is turned down with "The website does not show how customers agree to receive texts."
- **Sending.** A text shows as sent after about a quarter of a second and as delivered after about 0.7 seconds. A text whose body contains `[fail]` fails instead, with carrier error 30006.
- **Calls from the browser** use a stand-in for Twilio's calling library. It is ready at once, and a call you place "picks up" after a moment. No sound leaves the browser.
- **Voicemail recordings** are all the same three-second, two-note chime.
- **Incoming texts and calls** cannot be made by hand; only the browser tests fake them, by posting signed requests to the worker. To see what they look like, open Lone Star's seeded conversations in the inbox. They include texts, email, an unknown number, a STOP, and a voicemail with its transcript.
- **Memory resets** whenever the worker restarts, including each time `pnpm dev` reloads it after a code change. Registrations it no longer remembers then count as approved.
- **Reply reminders.** The email about an unanswered customer waits for the workspace's setting (10 minutes). To see it sooner, add `UNANSWERED_ALERT_MS=8000` to `apps/worker/.env` and restart `pnpm dev`. The next `pnpm env:local` removes that line again.

#### Mailpit (email)

- **Every email** the local stack sends lands in Mailpit at `http://127.0.0.1:54424`: sign-in emails from Supabase Auth, invitations and reminder alerts from the worker, and email a business sends to its customers. Nothing reaches a real inbox.
- **Delivery reports.** About 0.6 seconds after a business emails a customer, the worker reports the email as delivered to itself, the way Postmark would. If the first recipient's address ends in `@bounce.example.com`, it reports a hard bounce (`smtp;550 5.1.1 user unknown`) instead.
- **A business's own domain.** In **Settings** → **Email**, type the domain and click **Add domain**, then click **Check now**. It verifies at once. The DNS records it shows are placeholders (the DKIM value reads `LOCAL-DEVELOPMENT-KEY-NOT-REAL`). After a worker restart, domains it no longer remembers count as verified.
- **A customer writing in** has no button either. Post a message to the worker the way Postmark's inbound webhook would. The example writes as Mike Johnson (`mike.johnson@example.com`), one of Lone Star's seeded customers. Replace `<Lone Star address>` in both places with Lone Star's address on `mail.handsfreeos.com`, shown in Lone Star's **Settings** → **Email**. The login `postmark:local-postmark-webhook-password` is a fixed local value, not a secret. If you set your own `POSTMARK_WEBHOOK_PASSWORD` in `apps/worker/.env`, use that instead.

  ```bash
  curl -u postmark:local-postmark-webhook-password \
    -H 'content-type: application/json' \
    -d '{"MessageID":"local-test-1","From":"mike.johnson@example.com","FromFull":{"Email":"mike.johnson@example.com","Name":"Mike Johnson"},"ToFull":[{"Email":"<Lone Star address>","Name":"","MailboxHash":""}],"OriginalRecipient":"<Lone Star address>","Subject":"Question about my quote","TextBody":"Can you come out on Tuesday?"}' \
    http://127.0.0.1:4100/webhooks/postmark/inbound
  ```

  You should see `{"ok":true}` and, a moment later, the email in Lone Star's inbox. Give each message a new `MessageID`: the worker keeps only the first message with a given id. A wrong login gets `403`, and mail for an address no business owns is accepted and dropped. Mail from someone who is not in **Customers** does not reach the inbox. It waits in **Settings** → **Email** under **Mail from people not in Customers**.

#### The mailbox stand-in (Outlook and Gmail)

While neither `MICROSOFT_OAUTH_CLIENT_ID` nor `GOOGLE_OAUTH_CLIENT_ID` is set in `apps/worker/.env`, nothing reaches Microsoft or Google.

1. In a workspace, open **Settings** → **Email** and click **Connect Outlook**.

   You should see a page on the worker titled "Sign in to Outlook" that reads "A stand-in for Outlook’s sign-in on this development server. No real mailbox is touched."

2. Leave **Email address** as `owner@outlook.fake` or type another address, then click **Allow**. (**Cancel** shows what happens when someone backs out.)

   You should land back on **Settings** → **Email** with the mailbox connected.

How the stand-in behaves:

- Each stand-in mailbox lives in the worker's memory and is checked every 3 seconds. Email HandsFreeOS sends through it lands in that mailbox's Sent folder. A worker restart empties it.
- To drop an email into a connected stand-in mailbox, post it to the worker. Set `account` to the address you used on the stand-in page. Send it from the address of someone in **Customers**: connected mailboxes only bring in email with people in Customers.

  ```bash
  curl -H 'content-type: application/json' \
    -d '{"account":"owner@outlook.fake","from":{"address":"<customer email>","name":"<customer name>"},"subject":"Hello","text":"Is Tuesday still good?"}' \
    http://127.0.0.1:4100/test/mailboxes/deliver
  ```

  You should see a reply with a `providerMessageId`, and the email in the inbox within a few seconds. This address needs no login and only exists while the stand-in is active.

- **Connect Gmail** stays disabled with the badge "Waiting on Google’s review", even locally. To try the Gmail stand-in, add `NEXT_PUBLIC_GMAIL_ENABLED=true` to `apps/web/.env.local` and restart `pnpm dev`. Its stand-in page fills in `owner@gmail.fake`.

### Running the tests

Both kinds of tests need the local stack running and `pnpm env:local` done.

#### Unit, database, API and worker tests

1. To be safe, stop `pnpm dev` with Control-C, so its worker does not pick up jobs the tests create.
2. Run all four suites.

   ```bash
   pnpm test
   ```

   It runs the Vitest suites in `packages/core`, `packages/db` (which proves the row-level security rules), `apps/api` and `apps/worker`. You should see every suite pass, and Turbo's summary at the end should count every task as successful.

3. To run one suite, name its package. For example, the worker's:

   ```bash
   pnpm --filter @hfos/worker test
   ```

   The other packages are `@hfos/api`, `@hfos/db` and `@hfos/core`.

4. Run the lint and type checks CI also runs.

   ```bash
   pnpm lint && pnpm typecheck
   ```

   You should see Turbo's summary at the end count every task as successful.

5. Run the formatting check CI also runs.

   ```bash
   pnpm format:check
   ```

   You should see a line saying all matched files use Prettier code style.

6. If the format check lists files, fix them.

   ```bash
   pnpm format
   ```

7. Only after you change a command or query, regenerate the API client. CI checks that it is up to date.

   ```bash
   pnpm openapi
   ```

#### Browser tests (Playwright)

1. Stop `pnpm dev` with Control-C. The browser tests start their own worker on port 4100 with an 8-second reply reminder. If the dev worker still holds the port, it answers instead and the reminder test fails. Playwright starts the API and the web app itself when they are not running.
2. Put the stand-ins back if you changed `apps/worker/.env` for a real provider.

   ```bash
   pnpm env:local
   ```

   The test worker reads `apps/worker/.env`. With real Twilio, Postmark or mailbox settings there, the tests fail, and real Twilio could charge money.

3. Install the test browser. You only need to do this once.

   ```bash
   pnpm --filter @hfos/web exec playwright install chromium
   ```

4. Run the browser tests.

   ```bash
   pnpm test:e2e
   ```

   Two projects run, one test at a time: `chromium` (desktop Chrome at 1280 by 832) and `mobile` (a 390 by 844 phone, only the `*.mobile.spec.ts` files). Each test gets up to 90 seconds. You should see one line per test and a count of passed tests at the end.

5. To run one file:

   ```bash
   pnpm --filter @hfos/web exec playwright test e2e/inbox.spec.ts
   ```

6. To run only the phone project:

   ```bash
   pnpm --filter @hfos/web exec playwright test --project=mobile
   ```

7. When a test fails, Playwright keeps a trace and a screenshot in `apps/web/test-results` (Git ignores it). To replay the trace, run this with the folder of the failed test:

   ```bash
   pnpm --filter @hfos/web exec playwright show-trace test-results/<test folder>/trace.zip
   ```

The browser tests create their own users (password `correct-horse-battery-staple`) and their own businesses. They never use the seeded accounts, but what they create stays in your local database until you reset it.

### Trying a real provider from your laptop

The stand-ins cover almost everything. Switch one to the real provider only to check what the stand-ins cannot show, such as a text reaching a real phone. To try the real Twilio from a laptop, set `TELEPHONY_PROVIDER=twilio` and the Twilio keys in `apps/worker/.env`, and give the worker a public address with a tunnel as `WORKER_PUBLIC_URL`. Postmark, Outlook and Gmail work the same way.

#### Rules for real keys on a laptop

- **Provider keys go only in `apps/worker/.env`.** Git ignores that file. Never commit it, and never put keys in any other file in the repository.
- **Never `export` a provider key in your shell.** The API checks every variable it can see and refuses to start with `The API process must never hold privileged keys. Remove: <names>`. That covers any name containing `SECRET`, `SERVICE_ROLE`, `SIGNING_KEY` or `ENCRYPTION_KEY`, and any name starting with `TWILIO_`, `POSTMARK_`, `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_`.
- **`pnpm env:local` erases your edits.** It rewrites `apps/worker/.env` and `apps/web/.env.local`. Keep the lines you add in a secure note in your password manager, and paste them back after each run.
- **Restart after every edit.** Stop `pnpm dev` with Control-C, start it again, and read the `worker started` line to confirm which providers are live.
- **Only the worker's public address changes.** `NEXT_PUBLIC_WORKER_URL` in `apps/web/.env.local` stays `http://127.0.0.1:4100`, because your browser still reaches the worker directly.
- **Real Twilio costs money.** Numbers bought from the laptop are real numbers on the master account's bill.

#### Give the worker a public address

Providers call the worker over the internet, so it needs a public https address. The worker builds every address it gives providers from `WORKER_PUBLIC_URL` and checks Twilio's signatures against it, so that setting must be exactly the tunnel's address. The repository has no tunnel script. These steps use Cloudflare Tunnel (`cloudflared`), which is free.

There are two kinds of tunnel:

- **A fixed address,** `https://dev-hooks.handsfreeos.com`, through a named tunnel. It never changes, so Twilio, Postmark, Microsoft and Google are set up once. Use this one for Twilio.
- **A quick tunnel** with a random `trycloudflare.com` address. It needs no Cloudflare account, but the address changes every time you start it. It is fine for a one-off look at Postmark's reports or a mailbox sign-in, not for Twilio.

**A running tunnel is open to anyone.** While either tunnel runs, anyone who knows its address can reach the worker on your laptop. That includes `/test/mailboxes/deliver`, which needs no login while the mailbox stand-in is active, and the Postmark webhook addresses, which accept the fixed local password `local-postmark-webhook-password` until you set `POSTMARK_WEBHOOK_PASSWORD` in `apps/worker/.env`. Stop the tunnel with Control-C as soon as you finish. If you keep it running for more than a short test, set your own webhook password as in the Postmark part below, so the fixed one stops working.

Install `cloudflared` once:

1. Install it with Homebrew.

   ```bash
   brew install cloudflared
   ```

2. Check the version.

   ```bash
   cloudflared --version
   ```

   You should see a version such as `2026.9.1`. Avoid 2026.8.0 and 2026.8.1: those two versions changed how `cloudflared` passes on request paths, and 2026.8.2 undid the change. Signature checks depend on exact addresses, so a changed path makes them fail. Whatever the version, the health check through the tunnel (below) and the worker log line `rejected an unsigned or mis-signed webhook` tell you whether addresses arrive intact. Do not use `brew services start cloudflared`; run the tunnel in a Terminal tab as shown below.

To update `cloudflared` now and then:

```bash
brew upgrade cloudflared
```

#### Set up the fixed address (once)

The DNS for `handsfreeos.com` is on Cloudflare, so create the tunnel in the Cloudflare account that holds that domain. Use the hostname `dev-hooks.handsfreeos.com`. Do not use `hooks.handsfreeos.com`, which is the production worker on Fly.io. Do not use `dev.hooks.handsfreeos.com` either: Cloudflare's free certificate only covers one level of subdomain.

1. Sign in at `https://dash.cloudflare.com` and open the account that holds `handsfreeos.com`.
2. In the left sidebar, go to **Networking** → **Tunnels**. If you cannot find it, search the dashboard for "Tunnels". If Cloudflare first asks for a team name and a plan, choose the Zero Trust **Free** plan. It then asks for payment details, even on the Free plan; Cloudflare says the Free plan is not charged.
3. Click **Create a tunnel**. If Cloudflare asks which kind of connector to use, choose **Cloudflared**.
4. Enter the name `handsfreeos-dev-chris-mac` and click **Create Tunnel**.
5. On the next screen, choose **macOS** as the operating system. The page shows a command like `sudo cloudflared service install <tunnel token>`. Do not run it; it would keep the tunnel running at every boot. Copy only the long token that starts with `eyJ`.
6. Save the token in your password manager as "Dev tunnel token". It is a secret: anyone with it can run your tunnel. Never commit it.
7. Create a private folder for it.

   ```bash
   mkdir -p ~/.cloudflared
   ```

8. Open a new file for the token.

   ```bash
   nano ~/.cloudflared/handsfreeos-dev.token
   ```

   Paste the token, press Control-O, then Return, then Control-X.

9. Make the file readable only by you.

   ```bash
   chmod 600 ~/.cloudflared/handsfreeos-dev.token
   ```

10. Start the connector in a new Terminal tab.

    ```bash
    cloudflared tunnel run --token-file ~/.cloudflared/handsfreeos-dev.token
    ```

    You should see the dashboard show the connector as connected.

11. In the dashboard, click **Continue**.
12. Open the tunnel from **Networking** → **Tunnels**. On the **Routes** tab, click **Add route**, then **Published application**.
13. Enter `dev-hooks` under **Subdomain**, pick `handsfreeos.com` under **Domain**, leave any path field empty, and set **Service URL** to `http://127.0.0.1:4100`. Use `127.0.0.1`, not `localhost`: locally the worker only listens on 127.0.0.1, and on a Mac `localhost` can mean the IPv6 address instead.
14. Click **Add route**. Cloudflare creates the DNS record for `dev-hooks.handsfreeos.com` for you.

    You should see the tunnel listed as **Healthy** under **Networking** → **Tunnels**. **Inactive** means the connector has never connected, and **Down** means it stopped: check that the `cloudflared` tab from step 10 is running. **Degraded** means it is running but some of its connections fail, which is usually the network. `cloudflared` needs outbound port 7844 over both TCP and UDP, which some café and office networks block.

If the token ever leaks, or you want a new one:

1. Go to **Networking** → **Tunnels** and open the tunnel.
2. On the **Overview** tab, click **Refresh token**. The old token can no longer open new connections, but connectors that are already running stay connected.
3. From the install command it shows, copy only the long part that starts with `eyJ`. (**Add a replica** shows the same command later.)
4. Replace the token in `~/.cloudflared/handsfreeos-dev.token` (open it with `nano` as in step 8) and in your password manager. Never commit it.
5. After a leak, also delete the tunnel's existing connections, because one of them may not be yours. Cloudflare's documentation on rotating a tunnel token describes this as an API call that deletes all of a tunnel's connections; search Cloudflare's docs for "rotate tunnel token" to find it.
6. Stop the tunnel with Control-C in its tab and start it again with the command from step 10.

#### Point the worker at the tunnel (each session)

1. Start the stack and `pnpm dev` as usual.
2. If the tunnel is not already running in a Terminal tab, start it in a new tab.

   ```bash
   cloudflared tunnel run --token-file ~/.cloudflared/handsfreeos-dev.token
   ```

3. Check that the worker answers through it.

   ```bash
   curl https://dev-hooks.handsfreeos.com/healthz
   ```

   You should see `{"ok":true}`.

4. Open `apps/worker/.env` in a plain-text editor.

   ```bash
   nano apps/worker/.env
   ```

5. Change the `WORKER_PUBLIC_URL` line to the tunnel address, then save with Control-O, Return and Control-X.

   ```text
   WORKER_PUBLIC_URL=https://dev-hooks.handsfreeos.com
   ```

6. Stop `pnpm dev` with Control-C and start it again.

   You should see `publicUrl: "https://dev-hooks.handsfreeos.com"` in the `worker started` line.

Keep the tunnel tab open while you test, and stop it with Control-C in that tab as soon as you finish. Once it stops, providers can no longer reach the worker.

#### Quick tunnel with a random address

1. With `pnpm dev` running, start a quick tunnel in a second Terminal tab.

   ```bash
   cloudflared tunnel --url http://127.0.0.1:4100
   ```

2. Copy the address it prints in a box that says your quick tunnel has been created. It looks like `https://<random-words>.trycloudflare.com`.
3. Check it.

   ```bash
   curl https://<random-words>.trycloudflare.com/healthz
   ```

   You should see `{"ok":true}`. The first few seconds may fail while the address comes up.

4. Set `WORKER_PUBLIC_URL` in `apps/worker/.env` to that address (https, no path, no trailing slash). Edit it with `nano`, as in the fixed-address steps.
5. Stop `pnpm dev` with Control-C and start it again.

   You should see `publicUrl: "https://<random-words>.trycloudflare.com"` in the `worker started` line.

Every new run gives a new address, so repeat steps 2 to 5 and update each provider setting that held the old one. When you finish, remove any redirect URI on a `trycloudflare.com` address from the Entra and Google apps: once the tunnel stops, you no longer control that hostname. Quick tunnels do not work while a `config.yml` or `config.yaml` file exists in a folder `cloudflared` reads settings from: `~/.cloudflared`, `/etc/cloudflared` or `/usr/local/etc/cloudflared` (it also checks `~/.cloudflare-warp` and `~/cloudflare-warp`). The fixed tunnel above uses a token file and needs none of them.

#### Twilio

1. Start the fixed tunnel and set `WORKER_PUBLIC_URL=https://dev-hooks.handsfreeos.com`, as above.
2. Edit these lines in `apps/worker/.env`. `TELEPHONY_PROVIDER` is already there, so change its value rather than adding a second line. Copy the master account's **Account SID** and **Auth Token** from the "Twilio master account" entry in your password manager, or from the Twilio Console (see "Find the two values" in "The phone carrier: Twilio"). They are the same values as the `handsfreeos-worker` Fly.io secrets. The worker will not start with `TELEPHONY_PROVIDER=twilio` unless both the SID and the token are set. Never commit them.

   ```text
   TELEPHONY_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=<master account SID>
   TWILIO_AUTH_TOKEN=<master account auth token>
   ```

3. Only to try a local (10DLC) number: also add the id of the approved Trust Hub primary customer profile, which starts with `BU`. Copy it from the "Twilio primary customer profile SID" entry in your password manager, or from Trust Hub's customer profiles page in the Twilio Console. If you cannot find it, search the Console for "Customer profiles". Like every `TWILIO_` setting, it goes only in `apps/worker/.env`. Toll-free numbers do not need it. Without it, local-number registration is refused with "Local numbers cannot be registered yet: HandsFreeOS is finishing its own carrier profile. Use a toll-free number for now."

   ```text
   TWILIO_PRIMARY_PROFILE_SID=<primary customer profile SID>
   ```

4. Restart `pnpm dev`.

   You should see `telephony: "twilio"` in the `worker started` line. The worker now checks carrier registrations with Twilio every 15 minutes instead of every 2 seconds.

5. Sign in as `chris@gobizhelp.test`. **Create workspace** only shows for members of an organization, which locally means Chris or Riley.
6. Open the workspace switcher and click **Create workspace**.
7. Enter a **Business name** such as `Twilio Test`, pick a **Time zone**, and click **Create workspace**.

   You should see the new workspace open. Test with this new workspace, not Lone Star or any workspace set up before the switch: those hold the fake carrier's made-up ids, which start with `ACfake` or `PNfake`, and Twilio does not know them.

8. In the new workspace, open **Settings** → **Texting & calls**, click **Show numbers**, pick a toll-free number, and click **Buy <number>**. The button shows the number you picked.

   This spends real money. The worker creates a real subaccount named `HandsFreeOS <workspace name> <first 8 characters of the workspace id>` in the master account and buys the number inside it. You should see that subaccount in the Twilio Console, and the page moves on to its **Business details** step.

9. On **Business details for the carriers**, fill in every field. Tick **These details are accurate, and we only text customers who agreed to it.** and click **Submit for approval**.

   You should see the **Carrier review** step with an **In review** badge. Real carrier review is not instant and can take days; the worker checks for the result every 15 minutes.

10. Click **Turn on calls in this browser**, and allow the microphone when the browser asks.

    You should see **Calls ring in this browser**. Browsers allow the microphone on `http://localhost:3000` because they treat `localhost` as secure.

11. In **Customers**, click **Add person**. Enter your name, put your cell number under **Phone**, and click **Save person**.
12. From your cell, call the business number.

    You should see the call ring in the browser.

13. Open your own page in **Customers** and click **Call**, then **Call** again in the window that opens.

    Your phone should ring and show the business number.

14. Once texting is approved, text the business number from your cell.

    You should see the text in the inbox.

**Twilio keeps the addresses it was given.** When the worker creates a workspace's subaccount and buys its number, it writes these addresses into Twilio, built from `WORKER_PUBLIC_URL` at that moment. Nothing in HandsFreeOS updates them later.

| Where in the subaccount | What                                          | Address                                              |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------- |
| The phone number        | Incoming calls                                | `<public address>/webhooks/twilio/voice/inbound`     |
| The phone number        | Call status                                   | `<public address>/webhooks/twilio/voice/status`      |
| The phone number        | Incoming texts                                | `<public address>/webhooks/twilio/messaging/inbound` |
| The Messaging Service   | Incoming texts (the one Twilio actually uses) | `<public address>/webhooks/twilio/messaging/inbound` |
| The Messaging Service   | Text status                                   | `<public address>/webhooks/twilio/messaging/status`  |
| The TwiML App           | Calls placed from the browser                 | `<public address>/webhooks/twilio/voice/outbound`    |
| The TwiML App           | Call status                                   | `<public address>/webhooks/twilio/voice/status`      |

With the fixed tunnel address this never matters. If the worker's public address does change, Twilio keeps calling the old one. Either test with a new workspace, or edit each setting above by hand in that subaccount in the Twilio Console. The Console's names for these fields may differ from the table: look in the phone number's voice and messaging settings, the Messaging Service's integration settings, and the TwiML App.

The worker checks every Twilio signature against `WORKER_PUBLIC_URL` plus the request path. If they differ, Twilio gets `403 Invalid signature` and the worker logs `rejected an unsigned or mis-signed webhook`.

When you finish, release the numbers you bought for testing (see "Release a test number" in "The phone carrier: Twilio"). They cost money every month until you do. The laptop's subaccounts stay in the master account, pointed at the tunnel's address, and stop working when the tunnel closes.

#### Postmark

Test sending and delivery reports from the laptop, and test customers' replies on the hosted stack. Replies to `mail.handsfreeos.com` reach Postmark through the production MX record and go to the production server's inbound webhook. Pointing that webhook at your laptop would take real customers' replies away from production. For inbound email on the laptop, use the Mailpit `curl` example above.

A separate Postmark server for development keeps test mail and test webhooks away from production.

1. In Postmark, add a second server named `HandsFreeOS Dev`, and keep its default "outbound" stream. If you cannot find where to add a server, search Postmark's help for "create a server".
2. Copy the new server's API token from that server's **API Tokens** tab. If it has moved, search Postmark for "Server API token". Save it in your password manager as "Postmark dev server token". Never commit it.
3. Copy the account API token from the "Postmark account API token" entry in your password manager. If it is not there, copy it in Postmark from **Account** → **API Tokens** (only account owners and admins see it) and save it in your password manager. If that page has moved, search Postmark's help for "Account API token". It is the one the `handsfreeos-worker` Fly.io app uses. The worker needs it to add businesses' own domains, and it will not start with `EMAIL_TRANSPORT=postmark` unless this token and the server token are both set. It can change domains for the whole Postmark account, production included, so keep it only in `apps/worker/.env` and the password manager. Never commit it.
4. Make up a webhook password for the dev server.

   ```bash
   openssl rand -hex 24
   ```

   Save the output in your password manager as "Postmark dev webhook password". A hex value is safe inside a web address.

5. On the dev server's outbound stream, add a webhook to `https://postmark:<dev webhook password>@dev-hooks.handsfreeos.com/webhooks/postmark/events` for the **Delivery**, **Bounce** and **Spam Complaint** events. Look for the stream's webhook settings; if they have moved, search Postmark's help for "webhooks".
6. Add these lines to `apps/worker/.env`.

   ```text
   EMAIL_TRANSPORT=postmark
   POSTMARK_SERVER_TOKEN=<dev server API token>
   POSTMARK_ACCOUNT_TOKEN=<account API token>
   POSTMARK_WEBHOOK_PASSWORD=<dev webhook password>
   ```

   Leave `MAIL_DOMAIN` unset. The database hard-codes `mail.handsfreeos.com` and the worker must match it, so sending needs that domain already verified in the Postmark account (see Postmark Part D).

7. Restart `pnpm dev`.

   You should see `email: "postmark"` in the `worker started` line.

8. Sign in as `chris@gobizhelp.test` and open your test workspace. If you skipped the Twilio part, make one with **Create workspace**, as in steps 5 to 7 of the Twilio part.
9. In **Customers**, click **Add person**, enter one of your own real email addresses under **Email**, and click **Save person**.
10. Open that person, click **Email**, write a short message, and click **Send email**.

    You should see the email arrive in your real inbox from the business's `mail.handsfreeos.com` address. Shortly after, HandsFreeOS should show it as delivered, once Postmark's report comes back through the tunnel.

Invitations and reminder alerts still land in Mailpit: platform mail always uses `SMTP_URL`, whatever `EMAIL_TRANSPORT` says. Until Postmark approves the account, it may limit which addresses you can send to.

#### Outlook

This needs the Entra app and client secret from "Microsoft (Outlook and Microsoft 365)" in "Connected mailboxes: Outlook and Gmail". If you have not made them yet, do that part first.

1. Start the fixed tunnel and set `WORKER_PUBLIC_URL=https://dev-hooks.handsfreeos.com`, as above. Microsoft sends the sign-in back to the worker's public address and posts new-mail notifications there.
2. In the Microsoft Entra admin center (`https://entra.microsoft.com`), open **App registrations** and click the HandsFreeOS app. If the menu has moved, search the admin center for "App registrations".
3. Under **Manage**, click **Authentication**.
4. On the **Redirect URI configuration** tab, click **Add Redirect URI**, then the **Web** tile. Do not pick **Single-page application**.
5. In **Redirect URI**, enter `https://dev-hooks.handsfreeos.com/oauth/microsoft/callback` and click **Configure**.

   You should see it listed under **Web**, next to the production redirect URI. If the page looks different, search the app registration for "Redirect URIs".

6. Add these lines to `apps/worker/.env`. The **Application (client) ID** is on the app registration's overview page. The client secret value is the one you saved in the "Microsoft Entra app" entry in your password manager when you created it; Entra shows it only once. Never commit either value.

   ```text
   MICROSOFT_OAUTH_CLIENT_ID=<Application (client) ID>
   MICROSOFT_OAUTH_CLIENT_SECRET=<Microsoft client secret value>
   ```

7. Restart `pnpm dev`.

   You should see `mailboxes: "real"` in the `worker started` line. Either client ID switches both Outlook and Gmail to the real providers. The stand-in sign-in pages and the `/test/mailboxes/deliver` address go away, and **Connect Gmail**, if enabled, opens a page that says "Gmail isn’t set up yet" until Gmail's own ids are set. Stand-in mailboxes connected earlier will likely need reconnecting.

8. In a workspace, open **Settings** → **Email**, click **Connect Outlook**, and sign in with your Microsoft account.

   You should land back on **Settings** → **Email** with the mailbox connected. A sign-in link lasts ten minutes.

9. In **Customers**, click **Add person** and add yourself with an email address that is not the connected mailbox.
10. From that address, send an email to the connected mailbox.

    You should see it in the inbox within about a minute, because Microsoft notifies the worker through the tunnel. If Microsoft cannot reach the worker, the log shows `no Outlook notifications for now`; the worker asks again about six hours later and still checks the mailbox every 5 minutes. A newly connected mailbox brings in the last 30 days.

11. When you are done testing for a while, you can remove the dev redirect URI from the Entra app. Keep it if you plan to test again.

#### Gmail

This needs the Google OAuth client from "Google (Gmail)" in "Connected mailboxes: Outlook and Gmail". If you have not made it yet, do that part first.

1. Start the fixed tunnel and set `WORKER_PUBLIC_URL=https://dev-hooks.handsfreeos.com`, as above.
2. In the Google Cloud console, open the Web application OAuth client used for Gmail (the one with `https://hooks.handsfreeos.com/oauth/google/callback`). If the menu has moved, search the console for "OAuth clients" or "Credentials".
3. Under **Authorized redirect URIs**, click **Add URI**, enter `https://dev-hooks.handsfreeos.com/oauth/google/callback`, and click **Save**. Google can take a few minutes to apply the change.
4. While the app is in testing, only listed test users can sign in. In the Google Cloud console, open this project's OAuth consent screen settings and find the list of test users. If the menu has moved, search the console for "Test users".
5. If your Gmail address is not listed, add it and save.

   You should see your Gmail address in the test users list.

6. Add these lines to `apps/worker/.env`, using the client ID and secret from the "Google Gmail client" entry in your password manager. Never commit them.

   ```text
   GOOGLE_OAUTH_CLIENT_ID=<Google client ID>
   GOOGLE_OAUTH_CLIENT_SECRET=<Google client secret>
   ```

7. Add this line to `apps/web/.env.local`, so the web app shows **Connect Gmail**.

   ```text
   NEXT_PUBLIC_GMAIL_ENABLED=true
   ```

8. Restart `pnpm dev`. The web app only reads `NEXT_PUBLIC_` settings when it starts.

   You should see `mailboxes: "real"` in the `worker started` line and **Connect Gmail** enabled in **Settings** → **Email**.

9. Click **Connect Gmail** and sign in with the test-user Gmail address. Google may warn that it has not verified the app; as a test user you can continue.

   You should land back on **Settings** → **Email** with the mailbox connected. The worker checks Gmail every 2 minutes. Google makes testing sign-ins lapse every seven days.

#### Google sign-in for HandsFreeOS itself (optional)

This is signing in to HandsFreeOS with a Google account, handled by the local Supabase Auth. It is separate from connecting a Gmail mailbox and needs no tunnel. It needs its own OAuth client, separate from both the Gmail client and the hosted sign-in client.

1. In the Google Cloud console, open the `HandsFreeOS Sign-in` project if you have made it (see "Sign in with Google" in "The database: Supabase (hosted)"), or the `HandsFreeOS` project. In the `HandsFreeOS` project, only its test users can sign in while it is in testing.
2. Go to the Google Auth Platform **Clients** page and click **Create client**. If the menu has moved, search the console for "OAuth clients". If Google first asks you to set up the app's branding or consent screen, follow its prompts.
3. Set **Application type** to **Web application**.
4. Under **Authorized JavaScript origins**, add `http://localhost:3000`.
5. Under **Authorized redirect URIs**, add `http://127.0.0.1:54421/auth/v1/callback`.
6. Click **Create**.
7. Copy the client ID and the client secret right away, and save both in your password manager as "Google local sign-in client". Google shows the full secret only once.
8. Open the repository-root `.env` (created by the first `pnpm supabase:start`).

   ```bash
   nano .env
   ```

9. Fill in the two values, then save with Control-O, Return and Control-X. Git ignores this file; never commit it.

   ```text
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<local sign-in client ID>
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<local sign-in client secret>
   ```

10. Open `supabase/config.toml`.

    ```bash
    nano supabase/config.toml
    ```

11. Press Control-W, type `auth.external.google`, and press Return. On the first `enabled = false` line below it, change `false` to `true`. Save with Control-O, then Return, then Control-X. Git tracks this file, so never commit this change.
12. Restart the stack.

    ```bash
    pnpm supabase:stop && pnpm supabase:start
    ```

13. On `http://localhost:3000/sign-in`, click **Continue with Google** and choose your Google account.

    You should land back in HandsFreeOS, signed in. A Google address with no workspace yet goes to onboarding first.

When you finish testing, undo the `config.toml` change:

```bash
git restore supabase/config.toml
```

Then restart the stack again:

```bash
pnpm supabase:stop && pnpm supabase:start
```

#### Going back to the stand-ins

1. Stop `pnpm dev` with Control-C.
2. Rewrite the local settings. This keeps the encryption key.

   ```bash
   pnpm env:local
   ```

3. Stop the tunnel with Control-C in its tab.
4. Start `pnpm dev` again.

   You should see `telephony: "fake"`, `email: "smtp"` and `mailboxes: "fake"` in the `worker started` line.

Workspaces you set up against real Twilio now hold real ids the fake carrier cannot use. Reset the database (below) for a clean start. The subaccounts and numbers stay in Twilio until you release them there.

### Stopping and resetting

1. Stop the apps with Control-C in the `pnpm dev` window.

   You should see the worker log `worker stopping: closing the listener, then finishing the current pass` before it exits.

2. Stop the Supabase stack. Your local data is kept.

   ```bash
   pnpm supabase:stop
   ```

3. Optional: stop Colima to free memory.

   ```bash
   colima stop
   ```

Next time, start everything again in this order. You do not need `pnpm env:local` or the seed again.

```bash
colima start
```

```bash
pnpm supabase:start
```

```bash
pnpm dev
```

**Reset the database.** This wipes the local database, re-applies every migration in `supabase/migrations`, and seeds again. Everything you created locally is gone.

1. Stop `pnpm dev` with Control-C. Otherwise its worker can pick up jobs the seed creates, and it only sets up its recurring jobs when it starts.
2. Reset. The first part passes the worker's key to the seed, as in first-time setup.

   ```bash
   WORKER_ENCRYPTION_KEY="$(sed -n 's/^WORKER_ENCRYPTION_KEY=//p' apps/worker/.env)" pnpm db:reset
   ```

   You should see the seed's `Seeded in <n>s` message at the end.

3. Start `pnpm dev` again.

   ```bash
   pnpm dev
   ```

Do not use a bare `supabase db reset`: `supabase/seed.sql` is empty on purpose, so it leaves the app with no users.

**Restart once after the Milestone 2 migrations.** A stack started before those migrations existed must be restarted once, so the Realtime service creates its tables. Until then, the live-updates migration only warns, and live updates may not appear.

```bash
pnpm supabase:stop && pnpm supabase:start
```

**Start completely fresh.** Stop `pnpm dev` with Control-C first. This stops the stack and deletes its stored data.

```bash
pnpm supabase:stop --no-backup
```

Then run steps 2 to 4 of first-time setup again. `.env`, `supabase/signing_keys.json` and the app settings files stay, so the worker's encryption key does not change. If you ever delete `apps/worker/.env`, the next `pnpm env:local` makes a new key, and anything sealed with the old one no longer opens. Reset the database to fix that.

### Troubleshooting

- `The Supabase CLI is not installed. Install it with: brew install supabase/tap/supabase` from a `pnpm supabase:*` script, or `spawnSync supabase ENOENT` from `pnpm env:local`: the Supabase CLI is missing. Install it.

  ```bash
  brew install supabase/tap/supabase
  ```

- An error that mentions the Docker daemon when starting Supabase: Docker is not running. Start Colima, or open Docker Desktop.

  ```bash
  colima start
  ```

- `Command failed: supabase status -o env` from `pnpm env:local`: the Supabase CLI could not read the local stack, usually because the stack or Docker is not running. Start Docker:

  ```bash
  colima start
  ```

  Start the stack:

  ```bash
  pnpm supabase:start
  ```

  Then write the settings files again:

  ```bash
  pnpm env:local
  ```

- `supabase status did not return <NAME>; is the local stack running?` from `pnpm env:local`: the CLI answered, but without a value `pnpm env:local` needs. This usually means the Supabase CLI is too old. Update it, then run `pnpm env:local` again.

  ```bash
  brew upgrade supabase
  ```

- ``NEXT_PUBLIC_SUPABASE_URL is not set (run `pnpm env:local`)`` in the web app, or ``<NAME> is not set. Run `pnpm env:local` with the local Supabase stack running.`` from the tests or the seed: with the stack running, write the settings files, then restart `pnpm dev`.

  ```bash
  pnpm env:local
  ```

- ``WORKER_ENCRYPTION_KEY is required (openssl rand -base64 32); `pnpm env:local` writes one``: write the settings files.

  ```bash
  pnpm env:local
  ```

- `TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required with TELEPHONY_PROVIDER=twilio`, and the worker exits: add the missing line to `apps/worker/.env` (see the Twilio part) and restart `pnpm dev`. To use the fake carrier again instead, follow "Going back to the stand-ins".
- `POSTMARK_SERVER_TOKEN and POSTMARK_ACCOUNT_TOKEN are required with EMAIL_TRANSPORT=postmark`, and the worker exits: add both tokens to `apps/worker/.env` (see the Postmark part) and restart `pnpm dev`. To use Mailpit again instead, follow "Going back to the stand-ins".
- `The API process must never hold privileged keys. Remove: <names>`: a variable with one of those names is exported in your shell. This lists the matching names only, not their values:

  ```bash
  env | cut -d= -f1 | grep -iE 'SECRET|SERVICE_ROLE|SIGNING_KEY|ENCRYPTION_KEY|^TWILIO_|^POSTMARK_|^(MICROSOFT|GOOGLE)_OAUTH_'
  ```

  Remove each one from this window, or open a new Terminal window:

  ```bash
  unset <NAME>
  ```

  Also delete any matching `export` line from `~/.zshrc`. Provider keys belong only in `apps/worker/.env`.

- `No key <id> to open this value. Add the old key to WORKER_ENCRYPTION_KEYS_PREVIOUS.` in the worker log, or texting and calling from Lone Star fail: the data was sealed with a different key, for example because the seed ran without the key prefix. Reset the database as described under "Stopping and resetting".
- `Seed data is already present (chris@gobizhelp.test exists)...`: the seed already ran. Reset the database to start over.
- `No invitation email for <address> reached Mailpit (<url>) within 30s. Is the local Supabase stack running?` or `<n> outbox job(s) failed (see app.outbox.last_error). Is Mailpit's SMTP port reachable?`: the stack or Mailpit is down. Check it:

  ```bash
  pnpm supabase:status
  ```

  If it is not running, start it:

  ```bash
  pnpm supabase:start
  ```

  Then reset the database, because a seed that stopped halfway cannot continue.

- `Seeding messages failed (see last_error in app.outbox and app.scheduled_jobs).`: open Studio, choose the `app` schema, and read the `last_error` column in the `outbox` and `scheduled_jobs` tables. Then reset the database.
- "The phone service is not reachable right now. Try again in a minute." in the browser: the worker is not answering on `127.0.0.1:4100`. Look for a worker error in the `pnpm dev` window, and check the worker:

  ```bash
  curl http://127.0.0.1:4100/healthz
  ```

- `rejected an unsigned or mis-signed webhook` in the worker log: `WORKER_PUBLIC_URL` does not match the address the provider called. See the Twilio part above.
- `local email report failed` in the worker log: `WORKER_PUBLIC_URL` points at a tunnel that is not running, so the stand-in's delivery reports cannot reach the worker and emails never show as delivered. Start the tunnel, or set `WORKER_PUBLIC_URL` back to `http://127.0.0.1:4100`.
- A page that says "Outlook isn’t set up yet" or "Gmail isn’t set up yet": real mailboxes are on, but that provider's client ID or secret is missing from `apps/worker/.env`.
- "This sign-in link has expired": sign-in links last ten minutes. Go back to **Settings** → **Email** and click **Connect Outlook** or **Connect Gmail** again.
- Passkeys fail: open the app at `http://localhost:3000`, not `127.0.0.1`.
- Live updates never appear on an older stack: restart it once (see "Stopping and resetting").
- `the worker did not answer at http://127.0.0.1:4100/healthz` from the browser tests: the test worker failed to start, and its output is hidden. Start it by hand to see the error, then stop it with Control-C:

  ```bash
  pnpm --filter @hfos/worker exec tsx src/main.ts
  ```

- The reply-reminder browser test (`inbox-alert.spec.ts`) fails: `pnpm dev` was still running. Stop it and run the tests again.
- A browser test fails right after `pnpm test`, with a text or email stuck on queued: the test worker first works through the jobs the other suites left behind, oldest first, which can take a while. Run the browser tests again.
- `address already in use` for port 3000, 4000 or 4100: another `pnpm dev` or test run still holds it. The browser tests start their worker in the background, so an interrupted run can leave it holding port 4100 with no window. Find what holds the port (use the port from the message):

  ```bash
  lsof -i :4100
  ```

  Note the number in the **PID** column. If it belongs to a Terminal window you can see, press Control-C there. Otherwise, stop it:

  ```bash
  kill <PID>
  ```

- Twilio or Postmark calls never show up in the worker log through the fixed tunnel: if Bot Fight Mode is ever turned on for `handsfreeos.com`, Cloudflare may challenge those calls. Turn it off in the Cloudflare dashboard under **Security** → **Settings** (filter by bot traffic). If that menu has moved, search the dashboard for "Bot Fight Mode".

## Going live, and when something goes wrong

This section puts the other sections in order. It gives the order to set things up in, then a test of the whole hosted stack with a real phone and real email, then what to do when something breaks.

The hosted stack has no practice mode. In production the worker refuses `TELEPHONY_PROVIDER=fake`, so every number, text, call and registration in this section is real and costs money on the Twilio master account's bill.

### Before you start

You need:

- The tools and sign-ins in "Before you start" at the top of this guide. Check the Fly.io sign-in:

  ```bash
  fly auth whoami
  ```

  You should see your email address.

- The HandsFreeOS folder on this Mac, `~/Projects/HandsFreeOS`. Run every command in this section from it:

  ```bash
  cd ~/Projects/HandsFreeOS
  ```

- The accounts listed in "Before you start" at the top of this guide: Fly.io (with a payment card), Vercel (connected to GitHub), Twilio, Postmark, Microsoft Entra and the Microsoft AI Cloud Partner Program, and Google Cloud.
- Admin rights on the HandsFreeOS GitHub repository, `gobizhelp/handsfreeos`.
- Your password manager, with the `HandsFreeOS` folder. Every secret goes there first, then only into the place named in "Your password manager folder" at the top of this guide. None of these values ever goes into the repository, a commit, a chat or a support ticket.
- Access to the DNS settings for `handsfreeos.com` at Cloudflare.
- A website host for `handsfreeos.com`. Stage 0 below publishes a home page, a privacy policy and terms there. Google's consent screen needs the privacy policy and terms, Microsoft's publisher verification needs the domain, and Twilio checks that the site names the legal company.
- A mobile phone to play the customer.
- A second phone for the call and forwarding checks.
- A personal email address that is not on `handsfreeos.com` (a Gmail or iCloud address is fine) to play the customer.
- The real details of the business you test with: legal name, EIN, website and address. The carriers review them, so use a business you own. Go Biz Help is the simplest choice for the first workspace.

Never run these against the hosted project. They are for the local stack only:

- `pnpm db:seed` (the development seed; it expects Mailpit and local Supabase).
- `pnpm test:e2e` (the Playwright suite; it drives the fake carrier, Mailpit and stand-in mailboxes).
- `pnpm env:local`, `pnpm db:reset` and `supabase config push` (see "Push with the Supabase CLI" in "The database: Supabase (hosted)").

Vercel only holds `NEXT_PUBLIC_` values. Every one of them ends up in the browser, so a secret must never go there. GitHub's CI checks its own build of the web app for secret key formats and secret names. It never sees the values you type into Vercel, so nothing catches a secret pasted there. Before you save a Vercel variable, check that it is one of the seven in "Environment variables" in "The web app on Vercel".

### The go-live checklist

Work from top to bottom. Some steps wait on a provider's review, so start those on day one and do the rest while you wait. Do Stage 0 first: the reviews in Stage 1 look at the public website.

#### Stage 0: the public website

Twilio's Trust Hub business profile, Microsoft's branding and publisher domain, and Google's consent screen all look at `https://handsfreeos.com`. Nothing in this repository serves that address (the web app lives at `app.handsfreeos.com` on Vercel), so publish it first, on any website host.

1. On your website host, publish a home page for `https://handsfreeos.com` that describes HandsFreeOS.
2. Publish a privacy policy at `https://handsfreeos.com/privacy`. It must say how Google user data is accessed, used, stored and shared. It must also say HandsFreeOS follows Google's Limited Use requirements: the data is used only for features people see in HandsFreeOS, and is never used for ads or sold.
3. Publish the terms at `https://handsfreeos.com/terms`.
4. Put the legal company's name in the footer of every page, spelled exactly as on the IRS EIN letter. Twilio checks that the site names the legal company.
5. Sign in to Cloudflare and open the DNS records for `handsfreeos.com`.
6. Add only the records your website host asks for, on the bare domain (`@`) and on `www`. If an old A, AAAA or CNAME record on `@` or `www` points somewhere else, change only that record. If the host asks for DNS only (grey cloud), set that. Leave every other record alone: the same zone holds the MX and TXT records for your mail, and later the Postmark, Microsoft, Google, `api`, `hooks` and `app` records.
7. Check the home page.

   ```bash
   curl -sI https://handsfreeos.com
   ```

   You should see `200` on the first line (for example `HTTP/2 200`). New records can take a while to appear.

8. Check the privacy policy.

   ```bash
   curl -sI https://handsfreeos.com/privacy
   ```

   You should see `200` on the first line.

9. Check the terms.

   ```bash
   curl -sI https://handsfreeos.com/terms
   ```

   You should see `200` on the first line.

If a check fails with a certificate error, run `dig caa handsfreeos.com +short`. If it prints records, they must allow the certificate authority your website host uses. Ask the host which one that is.

#### Stage 1: start the slow reviews

1. Upgrade Twilio to a paid account, entering the business details and a payment card yourself (Twilio Step 1). Number purchases, client subaccounts and carrier registrations all need a paid account.

   You should see the trial banner gone and a balance on the console home page.

2. Create the Postmark account and ask Postmark to approve it (Postmark Part A). Until it is approved, Postmark only sends to domains you have added and verified in the account, so mail to customers and sign-in email to anyone else fails. Postmark says reviews finish in under 24 hours on weekdays.
3. Set up the Microsoft Entra app and start publisher verification. In "Microsoft (Outlook and Microsoft 365)" in "Connected mailboxes: Outlook and Gmail", do only the parts that happen in Microsoft's consoles: "Register the app", "Add the redirect URI", "Add the Microsoft Graph permissions", "Create the client secret", "Branding and the publisher domain" and "Publisher verification". Publisher verification takes several business days. The worker gets the Microsoft values in Stage 6, and you test Outlook in Check 9 of the end-to-end check.
4. Set up the Google Cloud project and the Gmail OAuth client. In "Google (Gmail)" in the same section, do only these parts: "Create the project and turn on the Gmail API", "Set up the Google Auth platform", "Verify the domain and fill in Branding", "Add the Gmail scopes (Data Access)", "Add test users (Audience)" and "Create the OAuth client (Clients)". Do not submit Google's restricted-scope verification yet. It needs a demo video of Connect Gmail working, which needs the worker, the web app and a workspace, so the submission waits until Stage 8. The review then takes weeks. Only Gmail waits on it.
5. Create HandsFreeOS's Trust Hub primary customer profile and get it approved (Twilio Step 4). Do not skip it. Toll-free verification can fail with "Approved profile is required" until Twilio approves the profile, so every client's texting waits on it. Only the `TWILIO_PRIMARY_PROFILE_SID` setting is limited to local numbers. When Twilio approves the profile, set its SID on the worker as that step describes. The worker app exists from Stage 4 on.

Leave the "Before you start" checks in "Connected mailboxes: Outlook and Gmail" until Stage 6, apart from the public pages from Stage 0. They need the worker and the web app.

#### Stage 2: Postmark's server, tokens and domains

The worker won't start without its Postmark tokens, and platform mail needs `handsfreeos.com` verified.

1. Create the production server, which comes with its `outbound` and inbound streams (Postmark Part B).
2. Save the server API token and the account API token in your password manager (Postmark Part C).
3. Add and verify `mail.handsfreeos.com` and `handsfreeos.com`, with their DKIM, Return-Path, MX and DMARC records (Postmark Part D).

   You should see both domains' DKIM and Return-Path marked as verified in Postmark. DNS changes can take a few hours.

#### Stage 3: collect the worker's other values

1. Copy the Supabase publishable key and create the worker's own secret key ("Copy the publishable key and the secret key" in "The database: Supabase (hosted)", steps 1 to 11).
2. Find the Twilio master account's **Account SID** and **Auth Token** ("Find the two values" in "The phone carrier: Twilio").
3. Check the Supabase Auth settings once ("Check the Auth settings" in "The database: Supabase (hosted)").

#### Stage 4: Fly.io

Do Fly Parts 1 to 9 ("Hosting: the API and the worker on Fly.io") in order: install and log in, create the organization with a card, create the two apps, decide the region, prepare every secret, check that the Postmark tokens and the Supabase key work and give them to Fly, deploy by hand, check the domain's CAA records, point `api.handsfreeos.com` and `hooks.handsfreeos.com` and get their certificates, and let GitHub deploy with an organization token. Twilio, Postmark, Microsoft and Google all call `https://hooks.handsfreeos.com`, so it must answer over HTTPS before any of them is pointed at it.

You should see, at the end:

1. A `worker started` line in `fly logs --app handsfreeos-worker --no-tail`, with `publicUrl` reading `https://hooks.handsfreeos.com`, `telephony` reading `twilio`, `email` reading `postmark`, `mailboxes` reading `real` and `storage` reading `true`. `storage` only shows that a Supabase key is set. The checks in Fly Part 6 are what show that the key and the Postmark tokens work.
2. `{"ok":true}` from the worker:

   ```bash
   curl https://hooks.handsfreeos.com/healthz
   ```

3. `{"ok":true,"service":"api","time":"…"}` with the current time from the API:

   ```bash
   curl https://api.handsfreeos.com/healthz
   ```

4. `FLY_API_TOKEN` in `gh secret list --repo gobizhelp/handsfreeos`, and a green Deploy run.

#### Stage 5: the web app on Vercel, and your first account

Several checks from here on sign in to the web app, so your first account comes now.

1. Follow "The web app on Vercel" up to and including step 15 of "Add app.handsfreeos.com": create the Pro team and the project with its seven settings, check the build settings, and add `app.handsfreeos.com`.

   You should see the newest deployment marked **Ready**, and the HandsFreeOS sign-in page at `https://app.handsfreeos.com`. Always use that address: the API and the worker only accept browsers on `https://app.handsfreeos.com`, so a `vercel.app` preview address or `www.` breaks them.

2. Create your first account and workspace with "Create your first account" in "The database: Supabase (hosted)". Sign up with the email address you use to sign in to Supabase. Until Stage 7, Supabase's built-in sender sends the confirmation email, and it only reaches members of the Supabase organization's team, at most 2 an hour.

   You should land in your workspace at an address like `https://app.handsfreeos.com/app/w/<workspace id>`.

3. Do steps 16 to 20 of "Add app.handsfreeos.com": sign in and add a test task.
4. Do Fly Part 10 to check that the web app reaches the API and the worker.

#### Stage 6: point the providers at the live worker

1. Check the worker's Postmark settings and test both webhook addresses (Postmark Part F).
2. Set up inbound for customers' replies (Postmark Part G), and send the test email to `test@mail.handsfreeos.com` there.
3. Set up delivery events (Postmark Part H).
4. In Twilio, lock the account down: geo permissions, HTTP authentication on media, auto-recharge, the low-balance email and the daily spending alert (Twilio Step 3).
5. In the Microsoft Entra admin center, open **App registrations** → **HandsFreeOS** → **Authentication**.

   You should see `https://hooks.handsfreeos.com/oauth/microsoft/callback` listed under **Web**, not under single-page application.

6. Do the checks in "Before you start" in "Connected mailboxes: Outlook and Gmail". Before Postmark approves the account, its invitation check only reaches an address on `handsfreeos.com`. If you have no mailbox there, do that one check after approval.
7. Give the worker the Microsoft client ID and secret ("Give the worker the Microsoft values") and the Google client ID and secret ("Give the worker the Google values"), both in "Connected mailboxes: Outlook and Gmail". The worker starts without them, but Connect Outlook needs the Microsoft pair. The Google pair does not turn on Connect Gmail; only the web build flag does that.

#### Stage 7: sign-in email and Sign in with Google

1. Only after Postmark approves the account, send Supabase's Auth email through Postmark ("Send Auth email through Postmark" in "The database: Supabase (hosted)"). Its test signs up a second address and resets that address's password, which proves the SMTP settings.
2. Turn on Sign in with Google ("Sign in with Google" in the same section). The sign-in and sign-up pages always show **Continue with Google**, and it fails until this is done.
3. If you have not created your account yet (Stage 5, step 2), create it now with "Create your first account" in the same section. This is Check 1 of the end-to-end check below.

#### Stage 8: test Gmail, then send it to Google's review

Google's restricted-scope review needs a demo video of Connect Gmail working, so it waits until the worker, the web app and your workspace exist. It needs only Stages 5 and 6, so if Postmark's approval holds up Stage 7, do this stage first. Do it only while no clients use HandsFreeOS: the web build flag turns **Connect Gmail** on for every user.

1. Check that the worker has the Google values (Stage 6, step 7).

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

   You should see `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the `NAME` column.

2. Turn Connect Gmail on for the test with the first two steps of "Test Gmail while Google's review is pending" in "Connected mailboxes: Outlook and Gmail": set `NEXT_PUBLIC_GMAIL_ENABLED` to `true`, then redeploy.
3. Start a screen recording for the demo video. On a Mac, press Command-Shift-5, click **Record Entire Screen**, then click **Record**.
4. Do the steps under "Then test with a test-user account" in that part, up to sending the reply. Keep the browser's address bar in view during the Google sign-in, so the client ID shows in the video.
5. Stop the recording with the stop button in the menu bar at the top of the screen.

   You should see the recording on your Desktop (where macOS saves it by default). Check that it shows the whole Connect Gmail sign-in with the client ID in the address bar, the customer's email arriving in the HandsFreeOS inbox, and the reply being sent.

6. Close Gmail again with the steps under "To close Gmail again after the test" in the same part.

   You should see **Connect Gmail** greyed out again, with the "Waiting on Google’s review" badge.

7. Submit the app with "Restricted-scope verification and the CASA assessment" in the same section. Google's review takes weeks. The rest of this checklist does not wait for it.

#### Stage 9: only now, buy the first number

When a workspace buys its first number, the worker writes `https://hooks.handsfreeos.com` into the number, the workspace's Messaging Service and its TwiML app. Nothing updates those addresses later, and no script re-points them. So buy a number only when all of these hold:

- The `worker started` line shows the right `publicUrl`.
- `https://hooks.handsfreeos.com/healthz` answers.
- Postmark has approved the account.
- HandsFreeOS's Trust Hub primary profile shows **Twilio Approved**, on the **Primary Profile** tab in Trust Hub (legacy console: **Customer Profiles**; see Twilio Step 4). Until then, toll-free verification can fail with "Approved profile is required".

Then run the end-to-end check below.

### Where to watch while you test

Open these before you start. Most problems name themselves in one of them.

- **Fly.io logs.** Keep the worker's log running in one Terminal window while you test, and the API's in a second. "Reading logs" in "Hosting: the API and the worker on Fly.io" shows how, and lists the log lines worth knowing.

  ```bash
  fly logs --app handsfreeos-worker
  ```

  ```bash
  fly logs --app handsfreeos-api
  ```

  To see whether the worker's machine is running and passing its health check:

  ```bash
  fly status --app handsfreeos-worker
  ```

- **Twilio console.** Each client's texts, calls and errors are logged in its own subaccount. See "Where to look in the Twilio console" in "The phone carrier: Twilio". Keep the Twilio auth tokens in your password manager, and paste them only into Twilio's own pages or your own terminal.
- **Postmark.** See "Where to look in Postmark" in "Email: Postmark".
- **Supabase.** For sign-in email, open the project's Auth logs in the Supabase dashboard (under the logs section; if it has moved, search the dashboard for "Auth logs"). They show errors when Supabase hands a message to Postmark.
- **Inside HandsFreeOS.**
  - **Message status.** A text shows as delivered only when Twilio's status report reaches the worker. An email shows as delivered only when Postmark's Delivery event reaches the worker. A message that stays at "sent" usually means a rejected webhook.
  - **Audit log.** In the sidebar, click **Audit log** (or open `https://app.handsfreeos.com/app/w/<workspace id>/audit`). In the box that shows **All activity**, choose **Inbox & texting**. It lists "sent a text to", "received a text from", "sent an email to" and "received an email".
  - **Settings** → **Texting & calls** shows the number and the carrier review. **Settings** → **Email** shows mailboxes, domains and **Blocked addresses**. Only owners and admins see these two pages.

### The end-to-end check

Start only after Postmark emails you that the account is approved. Until then, sign-up email only reaches addresses on `handsfreeos.com` or `mail.handsfreeos.com`, and email to your test customer fails.

Do the checks in order. Texting waits for the carriers, so after Check 4, do Checks 6 to 9 while you wait, then come back to Check 5.

#### Check 1: your account and workspace

If you have no account yet, follow "Create your first account" in "The database: Supabase (hosted)". The confirmation email proves Supabase's SMTP settings work, and the private-window sign-in at the end proves your password works.

You should land in your workspace at an address like `https://app.handsfreeos.com/app/w/<workspace id>`.

If you created your account in Stage 5, the sign-up and password-reset test in "Send Auth email through Postmark" (Stage 7) already proved the SMTP settings. Check your password instead:

1. Open a private browser window and go to `https://app.handsfreeos.com/sign-in`.
2. Enter your **Email** and **Password**, and click **Continue**.

   You should land in your workspace at an address like `https://app.handsfreeos.com/app/w/<workspace id>`.

3. Close the private window.

#### Check 2: note the workspace's email address

1. Open **Settings** → **Email** and note the workspace's address under **Sending address**. It looks like `<business-name>-<6 letters and digits>@mail.handsfreeos.com` (for example `go-biz-help-3f9a1c@mail.handsfreeos.com`). Copy it from the page rather than typing it.

#### Checks 3 and 4: buy a number and submit the carrier registration (costs money)

1. In the Twilio console, check that HandsFreeOS's Trust Hub primary profile shows **Twilio Approved** (see "Wait for Twilio's review" in Twilio Step 4). Toll-free verification can fail with "Approved profile is required" until it does.
2. Do "Round 1: right after you buy the number" in "Test with real phones" in "The phone carrier: Twilio", up to and including step 15. It adds you as a customer, buys a toll-free number, submits the business details, and checks the new subaccount in Twilio. Twilio charges the master account from the moment the number is bought.

   You should see "Sent to the carriers", then "The carriers are reviewing {business}" with the rows **Number bought**, **Toll-free verification** and **Texting turns on**. Toll-free verification usually takes a few days. The worker checks every 15 minutes and emails owners and admins "Texting is on for {business}" when it is approved, or "The carriers need a change before {business} can text" when it is turned down.

#### Check 5: text a real phone and get a reply (after approval)

When the "Texting is on" email arrives, do "Round 2: once texting is approved" in "Test with real phones". It adds your cell as a forwarding phone, sends **Text me a test**, checks replies, pictures, delivered status, STOP and START, and the audit log.

#### Check 6: call in, call out, and leave a voicemail

Do the rest of Round 1 (steps 16 to 26) as soon as the number is bought: turn on calls in this browser, take a call from the second phone, call your cell from your customer page with the business caller ID, and leave a voicemail. Calls work before the carriers approve texting.

#### Check 7: send an email and reply to it

Do Postmark Part J ("Test a real send and reply"), steps 1 to 15 under "After approval", using your customer page and your personal mailbox. Then do its platform mail and sign-in mail tests.

You should see the email marked delivered within a minute (that proves Postmark's Delivery webhook works), your reply in the same conversation within about a minute, and **Processed** in the Postmark inbound stream's **Activity**.

#### Check 8 (optional): the business's own domain

Use a domain the business owns, where you can edit DNS.

1. In **Settings** → **Email**, find **Use your own domain**, type the domain (for example `yourbusiness.com`), and click **Add domain**.

   You should see "Domain added. Now add the two records." and the badge **Waiting for DNS**.

2. At the domain's DNS provider, add the TXT record labeled "Proves the mail is yours (DKIM)", copying its Host and Value from the page.
3. Add the CNAME record labeled "Handles bounces (Return-Path)": Host `pm-bounces`, Value `pm.mtasv.net`. The hosts are shown relative to the domain; most DNS providers add the domain for you, so type them as shown.
4. Wait a few minutes, then click **Check now**. The page says "We check once a day and email you when it works", but no daily check runs today and no email is sent. Click **Check now** yourself until both records show **Verified**.

   You should see "{domain} is verified".

5. Under **Add an address on {domain}**, type the part before the @ (for example `office`) and click **Add address**.

   You should see "{address} is now the default address". The `mail.handsfreeos.com` address stays as the backup.

6. Send another email to your personal address and reply to it.

   You should see it come from the new address, with the reply address still on `mail.handsfreeos.com`, and the reply arrive in the inbox.

#### Check 9: connect Outlook

Do "Test Outlook with a personal account" in "Connected mailboxes: Outlook and Gmail", using your personal address as the test customer. If Microsoft asks for an admin's approval, see "Business clients: admin approval" in the same section.

You should come back to **Settings** → **Email** with "Connected. Email with customers comes in over the next few minutes." and the badge **Connected**, see mail with your test customer in the inbox within five minutes, and see your reply marked "sent through Outlook".

Leave Gmail until Google approves (see "Gmail asks to reconnect every week" below).

#### When you are done

If you do not keep the number, release it with "Release a test number" in "The phone carrier: Twilio". Released numbers cannot be recovered.

### When something goes wrong

Each entry gives the symptom, the likely cause and the fix. Start with `fly logs --app handsfreeos-worker`: most problems show there first.

#### The API refuses to start

**Symptom.** The deploy fails on the API step, `https://api.handsfreeos.com/healthz` does not answer, and `fly logs --app handsfreeos-api` shows one of the errors below. The machine keeps restarting and fails its health check.

| Error in the log                                                   | What to do                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The API process must never hold privileged keys. Remove: <names>` | The API app holds a secret whose name matches its guard: any name containing `SECRET`, `SERVICE_ROLE`, `SIGNING_KEY` or `ENCRYPTION_KEY`, or starting with `TWILIO_`, `POSTMARK_`, `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_` (upper or lower case). Usually a worker secret was set with `--app handsfreeos-api` by mistake. Follow the fix below. |
| `Invalid PORT: <value>`                                            | A `PORT` secret overrides the `4000` set in `apps/api/fly.toml`, or the value there was changed. Remove the secret (command below), or restore `PORT = "4000"` under `[env]` in `apps/api/fly.toml`.                                                                                                                                           |
| `DATABASE_URL must be a postgres:// URL for the hfos_api role`     | Set `DATABASE_URL` on the API.                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_URL must not connect as the postgres role`               | Use the user `hfos_api.ybupfghakoszfcxhyrby` in the string. The postgres check does not catch every form of the postgres user, so always use `hfos_api.ybupfghakoszfcxhyrby`.                                                                                                                                                                  |
| `SUPABASE_URL must be set to the Supabase API URL`                 | Restore `SUPABASE_URL` under `[env]` in `apps/api/fly.toml`.                                                                                                                                                                                                                                                                                   |

**Fix for the privileged-keys error.**

1. List the API's secret names. Only `DATABASE_URL` belongs there.

   ```bash
   fly secrets list --app handsfreeos-api
   ```

2. Remove each name the error listed. Fly restarts the API without it.

   ```bash
   fly secrets unset --app handsfreeos-api <NAME>
   ```

3. If that value belongs on the worker, set it there instead: start an import, paste `<NAME>=<value>` from your password manager, then press Return and Control-D.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

4. Check the API's health.

   ```bash
   curl https://api.handsfreeos.com/healthz
   ```

   You should see `{"ok":true,"service":"api","time":"…"}`.

To remove a stray `PORT` secret:

```bash
fly secrets unset --app handsfreeos-api PORT
```

A wrong password or user inside `DATABASE_URL` does not stop the API. It starts and `/healthz` still answers, because the API only connects to the database when a request needs it. Signed-in pages then fail, and `fly logs --app handsfreeos-api` shows an error from Supabase's connection pooler, such as `password authentication failed for user` (the password is wrong: copy the `DATABASE_URL` value from `.env.hosted` again) or `Tenant or user not found` (the user must be `hfos_api.ybupfghakoszfcxhyrby`, not `hfos_api`, or the pooler host is wrong; see "Check the pooler host" in "The database: Supabase (hosted)").

#### The worker refuses to start

**Symptom.** The deploy fails or times out on the worker step, `https://hooks.handsfreeos.com/healthz` does not answer, and `fly logs --app handsfreeos-worker` shows an error instead of `worker started`. The machine keeps restarting.

**Likely cause.** A setting is missing or wrong. `apps/worker/fly.toml` sets `NODE_ENV=production`, which switches on the production rules in `apps/worker/src/env.ts`. The worker checks its settings in the order of this table and stops at the first problem, so after one fix, read the log again for the next. The last row is checked after all the others.

| Error in the log                                                                              | What to do                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL_WORKER must be a postgres:// URL for the hfos_worker role`                      | Set `DATABASE_URL_WORKER` to the pooler string for `hfos_worker`.                                                                                                                                                                                             |
| `DATABASE_URL_WORKER must not connect as the postgres role`                                   | Use the user `hfos_worker.ybupfghakoszfcxhyrby`, never postgres.                                                                                                                                                                                              |
| `SMTP_URL must be an smtp:// or smtps:// URL`                                                 | Set `SMTP_URL` to `smtp://<server API token>:<server API token>@smtp.postmarkapp.com:587?requireTLS=true` (Fly Part 6). Postmark offers ports 25, 2525 and 587, not 465, so do not use `smtps://` with Postmark.                                              |
| `TELEPHONY_PROVIDER must be twilio or fake`                                                   | A value is misspelled. Remove any `TELEPHONY_PROVIDER` secret, and keep `TELEPHONY_PROVIDER = "twilio"` under `[env]` in `apps/worker/fly.toml`.                                                                                                              |
| `TELEPHONY_PROVIDER=fake is for development and tests only`                                   | Same fix.                                                                                                                                                                                                                                                     |
| `TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required with TELEPHONY_PROVIDER=twilio`        | Set both from the Twilio master account.                                                                                                                                                                                                                      |
| ``WORKER_ENCRYPTION_KEY is required (openssl rand -base64 32); `pnpm env:local` writes one``  | Set `WORKER_ENCRYPTION_KEY`. On the very first deploy, make one (Fly Part 6). After that, only ever paste the saved one from your password manager: a new key cannot open anything sealed with the old one. (`pnpm env:local` is for local development only.) |
| `Invalid WORKER_HTTP_PORT: <value>`                                                           | Remove any `WORKER_HTTP_PORT` secret, and keep `WORKER_HTTP_PORT = "4100"` under `[env]` in `apps/worker/fly.toml`.                                                                                                                                           |
| `WORKER_PUBLIC_URL must be the https:// address providers call`                               | It must be `https://hooks.handsfreeos.com`, as `apps/worker/fly.toml` sets it. Remove any secret that overrides it.                                                                                                                                           |
| `EMAIL_TRANSPORT must be postmark or smtp`                                                    | Remove any `EMAIL_TRANSPORT` secret. Production uses `postmark` by default.                                                                                                                                                                                   |
| `POSTMARK_SERVER_TOKEN and POSTMARK_ACCOUNT_TOKEN are required with EMAIL_TRANSPORT=postmark` | Set both (Postmark Part C).                                                                                                                                                                                                                                   |
| `POSTMARK_WEBHOOK_PASSWORD must be a long random value (24+ characters)`                      | Set a password of 24 or more characters. `openssl rand -hex 24` makes 48. The worker needs it on Fly.io even before Postmark's webhooks are set up.                                                                                                           |
| `MAILBOX_PROVIDER must be real or fake`                                                       | Remove any `MAILBOX_PROVIDER` secret.                                                                                                                                                                                                                         |
| `MAILBOX_PROVIDER=fake is for development and tests only`                                     | Same fix.                                                                                                                                                                                                                                                     |
| `WORKER_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)`     | Checked after all the others. The key was cut or changed when pasted. Paste the saved key again exactly. The same check runs on every key in `WORKER_ENCRYPTION_KEYS_PREVIOUS`.                                                                               |

Two more errors come from Supabase's connection pooler, not from the worker, and they only show after every check above passes. `password authentication failed for user` means the password in `DATABASE_URL_WORKER` is wrong: copy the `DATABASE_URL_WORKER` value from `.env.hosted` again (right after a password change, wait 30 seconds first). `Tenant or user not found` means the user is not `hfos_worker.ybupfghakoszfcxhyrby`, or the pooler host is wrong; a bare `hfos_worker` fails.

**Fix.**

1. Read the error.

   ```bash
   fly logs --app handsfreeos-worker --no-tail
   ```

2. List the worker's secret names to see what is set.

   ```bash
   fly secrets list --app handsfreeos-worker
   ```

3. Set the missing or wrong value. Start an import, paste `<NAME>=<value>` from your password manager without quotes, then press Return and Control-D. Fly restarts the worker with it. Before the first deploy, add `--stage`, then deploy again.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

   To remove a setting that should not be a secret:

   ```bash
   fly secrets unset --app handsfreeos-worker <NAME>
   ```

   If the setting is under `[env]` in `apps/worker/fly.toml` instead, fix it there, commit, and deploy.

4. Watch the log again.

   ```bash
   fly logs --app handsfreeos-worker
   ```

   You should see `worker started`.

Some gaps do not stop the worker but break features later: a missing or wrong `SUPABASE_SECRET_KEY` (photos, voicemails, attachments, imports), missing Microsoft client values (Connect Outlook), and a missing `TWILIO_PRIMARY_PROFILE_SID` (local-number registrations). Each has its own entry below or in its section. The worker also starts with Postmark tokens that are set but wrong; customer email then fails, and so does adding a business's own domain. "Check the Postmark tokens and the Supabase key" in Fly Part 6 catches a wrong key or token before it goes live.

#### The Deploy workflow did nothing

**Symptom.** The Deploy run shows the notice "FLY_API_TOKEN is not set, so nothing was deployed."

**Likely cause.** The GitHub repository has no `FLY_API_TOKEN` secret.

**Fix.** Make a Fly.io organization token and store it in GitHub with steps 1 to 4 of Fly Part 9. Then run **Actions** → **Deploy** → **Run workflow** again.

You should see the run deploy the worker and the API and finish with a green check.

#### Number search says the phone service is not reachable

**Symptom.** In **Settings** → **Texting & calls**, **Show numbers** shows "The phone service is not reachable right now. Try again in a minute." Browser calls and **Connect Outlook** may fail too.

**Likely cause.** The browser cannot reach the worker. Either `NEXT_PUBLIC_WORKER_URL` is missing in Vercel (it then points at `127.0.0.1`), the app was opened from an address other than `https://app.handsfreeos.com` (the worker only accepts that one), or the worker is down.

**Fix.**

1. Check the worker's health. If it does not answer, see "The worker refuses to start".

   ```bash
   curl https://hooks.handsfreeos.com/healthz
   ```

2. In Vercel, check that `NEXT_PUBLIC_WORKER_URL` is `https://hooks.handsfreeos.com`, then redeploy the web app ("Redeploy after a change" in "The web app on Vercel"). The value is fixed at build time.
3. Open the app at `https://app.handsfreeos.com` only.

If instead you see "The phone carrier did not answer. Try again in a minute.", the worker reached Twilio and Twilio refused. Number search runs on the master account's credentials. Check the worker log, and check that `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` match the master account. If the master auth token was changed in Twilio but not on the worker, set the new one: start an import, paste `TWILIO_AUTH_TOKEN=<master account auth token>`, then press Return and Control-D.

```bash
fly secrets import --app handsfreeos-worker
```

#### A number is stuck on Setting up

**Symptom.** After **Buy <number>**, the page keeps showing "Setting up <number>. This takes a few seconds." The worker log shows `outbox handler failed` with `eventType` `phone_number.purchase_requested`.

**Likely cause.** Before buying, the worker creates the client's subaccount, Messaging Service, API key and TwiML app with the master account's credentials. If Twilio refuses that step (the account is still on trial, the master SID or auth token is wrong, the master auth token was changed in Twilio but not on the worker, or Twilio is down), the worker tries 5 times in all over about a minute and then stops. The number stays at "Setting up".

**Fix.**

1. Find Twilio's error in the log lines around `outbox handler failed`.
2. Fix the cause: upgrade Twilio, or set the right master credentials on the worker. Start an import, paste the two lines below with your values, then press Return and Control-D.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

   ```text
   TWILIO_ACCOUNT_SID=<master account SID>
   TWILIO_AUTH_TOKEN=<master account auth token>
   ```

3. Do not try to buy again from the same workspace; it answers "This workspace already has a business number."
4. Ask a developer to requeue the purchase or reset the number in the database. No button or script does this today.

If the page shows "We couldn’t buy <number>: <error> Pick another number.", Twilio refused that one number. Pick another.

#### Twilio webhooks are rejected

**Symptom.** Texts to the business number never reach the inbox, callers hear a Twilio error message instead of ringing, or sent texts never show as delivered. The worker log shows `rejected an unsigned or mis-signed webhook` with a path and an `accountSid`. The subaccount's Debugger shows error 11200 with a 403 answer and the body `Invalid signature`.

**Likely cause.** The worker checks each Twilio request's signature against `WORKER_PUBLIC_URL` plus the path Twilio called, never against the address the request arrived on. So `WORKER_PUBLIC_URL` must match exactly what Twilio calls: `https://hooks.handsfreeos.com`, with no port and no path. A client number's requests are checked with that client subaccount's own auth token, which the worker sealed when it made the subaccount. It breaks when:

- the number was bought while `WORKER_PUBLIC_URL` was different (a `fly.dev` address, for example), so Twilio still calls the old address;
- a client subaccount's auth token was changed by hand in Twilio (the worker keeps its own sealed copy from when it made the subaccount, so never rotate a subaccount's token);
- the number was bought by hand in the Twilio console. HandsFreeOS has no record of it. Twilio only calls the worker if someone points the number at it, and then callers hear "Sorry, this number is not in service." and texts to a number in the master account are dropped. If the number sits in a subaccount HandsFreeOS did not create, the worker rejects its requests. Only numbers bought in **Settings** → **Texting & calls** work.

**Fix.**

1. In the `worker started` log line, check that `publicUrl` is `https://hooks.handsfreeos.com`.
2. Check the certificate.

   ```bash
   fly certs check hooks.handsfreeos.com --app handsfreeos-worker
   ```

3. In the subaccount's Debugger, open the 11200 error and read the address Twilio called.
4. If that address does not start with `https://hooks.handsfreeos.com/`, re-point the subaccount by hand. No script does this. In the subaccount, change each address to start with `https://hooks.handsfreeos.com` and keep its path:
   - the phone number: incoming calls `/webhooks/twilio/voice/inbound`, call status `/webhooks/twilio/voice/status`, incoming messages `/webhooks/twilio/messaging/inbound`;
   - the Messaging Service named `HandsFreeOS <8 characters>`: incoming messages `/webhooks/twilio/messaging/inbound`, status callback `/webhooks/twilio/messaging/status`;
   - the TwiML app named `HandsFreeOS calls <…>`: voice `/webhooks/twilio/voice/outbound`, status callback `/webhooks/twilio/voice/status`.

   If the menus have moved, search the console for "Active numbers", "Messaging Services" and "TwiML apps". For a test workspace it is simpler to release the number and start again in a new workspace, which gets a new subaccount with the right addresses.

5. Text the business number.

   You should see the text in the inbox and no new 11200 errors. Texts that were rejected earlier do not come back on their own; read them in the subaccount's Messaging logs.

#### Postmark webhooks are rejected

**Symptom.** Customers' email replies never reach the inbox, or sent email stays at "sent" and never shows as delivered. The worker log shows `rejected an inbound mail webhook without the right credentials` or `rejected a mail event webhook without the right credentials`. Postmark's test of the outbound webhook gets a 403.

**Likely cause.** The worker compares the whole login in the webhook address with `postmark:<POSTMARK_WEBHOOK_PASSWORD>`, character for character. It fails when the password differs between Fly.io and Postmark, when only one of the two webhooks was updated, when the user is not `postmark`, or when the password has characters that change inside a URL (`@ : / ? # % + =`). Output of `openssl rand -base64` can contain `+`, `/` and `=`.

**Fix.**

1. Set a new webhook password on the worker and in both Postmark webhooks with "Changing the Postmark webhook password" in "Hosting: the API and the worker on Fly.io". It uses `openssl rand -hex 24`, which makes letters and digits only. The inbound webhook address is `https://postmark:<webhook password>@hooks.handsfreeos.com/webhooks/postmark/inbound`, and the events webhook address is `https://postmark:<webhook password>@hooks.handsfreeos.com/webhooks/postmark/events`, with Delivery, Bounce and Spam Complaint ticked.
2. Save the outbound webhook. Postmark tests it when you save.

   You should see the worker answer 200.

3. Retry replies that failed while the password was wrong. In the inbound stream's **Activity**, open each **Failed** message (Postmark may label it **Inbound Error**) and note its message ID. Then use Postmark's API Explorer (`https://postmarkapp.com/api-explorer`, Messages API, retry a failed inbound message), or run this in your terminal with the server API token from your password manager:

   ```bash
   curl "https://api.postmarkapp.com/messages/inbound/<message id>/retry" -X PUT -H "Accept: application/json" -H "X-Postmark-Server-Token: <server API token>" -d ""
   ```

   You should see "Successfully rescheduled failed message", and the reply appear in the inbox.

Delivery and bounce events rejected with a 403 are not sent again, so those emails stay at "sent". New ones work once the password matches.

#### Texts do not send

**Symptom.** The composer refuses the text, or the text fails after it goes out.

**Likely cause and fix.** The composer names the reason:

| Message                                                              | Cause                                                                            | Fix                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Get a business number to text customers."                           | No number, or the number is not active yet.                                      | Buy one in **Settings** → **Texting & calls**, or wait for "Setting up" to finish.                                                               |
| "Texting turns on when the carriers approve your registration."      | The registration is still under review.                                          | Wait. Calls already work. **Settings** → **Texting & calls** shows the review. The worker checks every 15 minutes and emails when texting is on. |
| "This customer texted STOP. They can text START to get texts again." | The customer opted out, by texting STOP or because Twilio reported error 21610.  | Only the customer can undo it, by texting `START`.                                                                                               |
| "It’s <time> where the business is. Quiet hours end at <time>."      | Quiet hours, on by default from 8:00 PM to 8:00 AM in the workspace's time zone. | Click **Send now** to send anyway, or change the hours in **Settings** → **Texting & calls** → **Texting rules** → **Quiet hours**.              |
| "Add a mobile number to text this customer."                         | The customer has no phone number.                                                | Add one on the customer's page.                                                                                                                  |
| "Restore this customer before texting them."                         | The customer is archived.                                                        | Restore them first.                                                                                                                              |

If a text went out and then failed, open it in the subaccount's Messaging logs and look up the error code (see "Where to look in the Twilio console" and "When something goes wrong" in "The phone carrier: Twilio").

If the review page says "The carriers turned down the texting registration.", read "Their reason". Some reasons come from HandsFreeOS itself, before the carriers ever see it, and send no email (see "Carrier review and how long it takes" in "The phone carrier: Twilio"):

- "Local numbers cannot be registered yet: HandsFreeOS is finishing its own carrier profile. Use a toll-free number for now." `TWILIO_PRIMARY_PROFILE_SID` is not set. Release the number and buy a toll-free one, or set the profile once Trust Hub approves it.
- "Sole proprietors text from a toll-free number. Release this number and pick a toll-free one."
- "Local numbers need at least two example texts. Add another example and submit again."
- "The carriers need more business details: <problems>." Fix the listed details.

For a real carrier rejection, click **What to fix**, correct the details (often the opt-in wording on the website), and click **Fix and send again**. Read the warning in "Carrier review and how long it takes" first: today a resend after a real carrier rejection only re-checks the old request.

#### Calls do not ring, or cannot be placed

**Symptom and fix.**

- **A call goes straight to voicemail.** Nobody has turned calls on. Each teammate clicks **Turn on calls in this browser** in the sidebar, in each browser. Only members whose role can use the inbox are rung, plus up to 3 phones under **When a customer calls**.
- **The sidebar says "Microphone blocked. Allow it in the address bar."** Allow the microphone for `app.handsfreeos.com` in the browser's address bar, then reload.
- **Callers hear "Sorry, this number is not in service."** The number is not active yet, or is being released.
- **Callers hear "Sorry, nobody can take your call right now. Please try again later."** Voicemail is off. Turn it on in the **Voicemail** card.
- **The sidebar has no Turn on calls in this browser button, and calling out shows "Get a business number first. Calls work as soon as you have one." or "Calls are still being set up. Try again in a minute."** The workspace has no active number yet, or its call setup has not finished. The app asks the worker for a calling token when it loads. While the worker refuses it, the sidebar button stays hidden, and these messages show when you click **Call**. Wait until the **Business number** card shows in **Settings** → **Texting & calls**. The sidebar button then appears; reload the page if it does not.
- **The customer hears "Sorry, this call could not be placed."** The worker log shows `refused a browser call that call.start did not record`. Start the call from the customer's **Call** button, not a stale dialer, and try again.

#### Emails bounce or are blocked

**Symptom.** An email shows as bounced, or the composer refuses to send to an address.

**Likely cause.** The reason shown tells you:

- "that address doesn’t exist": a hard bounce. The address is blocked.
- "the customer’s mail server blocked it": the customer's mail system refused it.
- "the sending domain’s DNS records need fixing": DMARC failed. Check the DKIM, Return-Path and DMARC records for `mail.handsfreeos.com`, or for the business's own domain.
- "the customer marked it as spam": a spam complaint. The address is blocked.
- "This address bounced or reported spam before, so the mail service won’t send to it.": Postmark had already stopped the address. Postmark's list covers the whole stream, so an address one business bounced is stopped for every business.
- "Email to this address bounced, so it’s stopped. Check the address with the customer.", "This customer marked an earlier email as spam, so email to them is stopped." or "Email to this address is stopped. Release it in Settings → Email to send again.": HandsFreeOS's own block list for this business.
- Every email to outside addresses fails: Postmark has not approved the account yet.

**Fix.**

1. Check the address with the customer and correct it on their page if it was wrong.
2. To send to a blocked address again, open **Settings** → **Email** → **Blocked addresses** and click **Unblock**.
3. Also release it in Postmark: open the outbound stream's **Suppressions** tab, search for the address, and click **Reactivate**. That works for hard bounces and manual blocks. Only Postmark support can release a spam complaint. Reactivating does not resend earlier email.
4. If nothing reaches outside addresses, check Postmark's account approval.
5. If customers' replies bounce back to them, check the MX record for `mail.handsfreeos.com` (`inbound.postmarkapp.com`, priority 10) and the inbound domain on Postmark's inbound stream.

#### Sign-in emails do not arrive

**Symptom.** After **Create account** or **Forgot password?**, no email arrives. Or a link lands on `/sign-in?error=link`.

**Likely cause.**

- Custom SMTP is off in Supabase. The built-in sender only mails the project's team members ("Email address not authorized") and only 2 an hour.
- The SMTP settings are wrong: the account API token was used instead of the SMTP token or the server API token, or the port is wrong.
- The sender's domain is not verified in Postmark, or Postmark has not approved the account.
- The rate limit was hit: 30 an hour by default with custom SMTP, until you raise it.
- Postmark has stopped the address after an earlier bounce.
- For `/sign-in?error=link`: the link expired or was already used, or the Site URL is not `https://app.handsfreeos.com`.

**Fix.**

1. Open Supabase's Auth logs and look for a sending error.
2. In Postmark's outbound **Activity**, search for the address. If the email is there, follow its status. If it is not, Supabase never handed it over.
3. Check the settings in **Authentication** → **Emails** → **SMTP Settings** against "Send Auth email through Postmark" in "The database: Supabase (hosted)": host `smtp.postmarkapp.com`, port `587`, the SMTP token's Access Key and Secret Key (or the server API token as both username and password), and a sender on a domain verified in Postmark.
4. If the rate limit was hit, raise it under **Authentication** → **Rate Limits**.
5. If Postmark lists the address under **Suppressions**, click **Reactivate**.
6. Try again with **Forgot password?** on the sign-in page.

   You should see the email within a minute.

#### Invitations, reminders and notices do not arrive

**Symptom.** Invitations, "<customer> is waiting for a reply", "Texting is on for <business>" or "Reconnect your <Outlook|Gmail> mailbox" emails never arrive. The worker log may show `outbox handler failed` at the time.

**Likely cause.** This mail goes through the worker's `SMTP_URL`, from `alerts@handsfreeos.com`. Either `SMTP_URL` is wrong (an `smtps://` address, port 465, or the account API token), `handsfreeos.com` is not verified in Postmark, or Postmark has not approved the account. Before approval, this mail only reaches addresses on `handsfreeos.com`. The worker ignores Postmark's reports for this mail, so bounces only show in Postmark.

**Fix.**

1. Set `SMTP_URL` on the worker. Start an import, paste the line below with the server API token from your password manager in both places, then press Return and Control-D.

   ```bash
   fly secrets import --app handsfreeos-worker
   ```

   ```text
   SMTP_URL=smtp://<server API token>:<server API token>@smtp.postmarkapp.com:587?requireTLS=true
   ```

2. Verify `handsfreeos.com` in Postmark (Postmark Part D).
3. Check the outbound **Activity** for the address, and the worker's log for errors from the time you sent it.

#### Outlook is blocked by the client's Microsoft admin

**Symptom.** After **Connect Outlook**, Microsoft shows "Approval required" or "Need admin approval", or an error such as `AADSTS90094`, `AADSTS90095` or `AADSTS65001`. Back in HandsFreeOS the message reads "Sign-in cancelled. Nothing was connected." or "That mailbox didn’t connect. Try again in a minute." The mailbox may stay listed as **Connecting** until removed with the **X**.

**Fix.** The client's Microsoft 365 admin approves HandsFreeOS once. "Business clients: admin approval" in "Connected mailboxes: Outlook and Gmail" explains why this happens and the four ways to approve. Then the teammate removes the stuck mailbox with the **X** and clicks **Connect Outlook** again.

You should see "Connected. Email with customers comes in over the next few minutes."

#### Outlook stops syncing for everyone

**Symptom.** Every Outlook mailbox shows **Not syncing** with "Microsoft refused the sign-in (invalid_client)."

**Likely cause.** The Entra app's client secret expired. Reconnecting does not help.

**Fix.** Create a new client secret and set it on the worker with "Rotating the client secrets" in "Connected mailboxes: Outlook and Gmail". Since the old one has already expired, skip that procedure's two-hour wait. Put the new expiry date in your calendar.

You should see the mailboxes return to **Connected** within about 30 minutes.

#### Connecting a mailbox fails

The pages the worker shows during sign-in, and the messages back in **Settings** → **Email**, are listed in "When a connection fails" in "Connected mailboxes: Outlook and Gmail". The most common:

- **A page says "Outlook isn’t set up yet" or "Gmail isn’t set up yet".** The worker has no client ID and secret for that provider.
- **A page says "This sign-in link has expired".** Sign-in links last ten minutes. Go back to **Settings** → **Email** and click **Connect Outlook** again. This page also appears after a Microsoft admin approves HandsFreeOS through an admin consent link; the approval still counts.
- **Settings → Email says "HandsFreeOS needs permission to read and send mail. Connect again and leave every box ticked."** A permission box was unticked on the sign-in screen. Connect again with every box ticked.

#### Gmail asks to reconnect every week

This only happens if a Gmail mailbox was connected while the Google app was still in testing, for example after `NEXT_PUBLIC_GMAIL_ENABLED=true` was set for a test before Google approved. Otherwise, on the hosted stack before approval, **Connect Gmail** is greyed out, so no Gmail mailbox exists to expire.

**Symptom.** Every week an email "Reconnect your Gmail mailbox" arrives, and the mailbox shows **Needs reconnecting**.

**Likely cause.** While the Google app is in testing, Google ends test users' sign-ins after seven days. This is expected until Google approves the restricted scopes.

**Fix.**

1. In **Settings** → **Email**, click **Reconnect** on the mailbox and sign in again. **Reconnect** works even while **Connect Gmail** is greyed out. Nothing is lost; mail from the gap comes in.
2. For good, finish Google's restricted-scope verification and CASA assessment, publish the app, then set `NEXT_PUBLIC_GMAIL_ENABLED=true` in Vercel and redeploy the web app ("Turn Gmail on for everyone" in "Connected mailboxes: Outlook and Gmail").

**Connect Gmail** stays greyed out until the web build has `NEXT_PUBLIC_GMAIL_ENABLED=true`, and that turns it on for every user. There is no per-person switch, so try Gmail on the hosted stack before Google approves only while no clients use HandsFreeOS (see "Test Gmail while Google's review is pending").

If a Gmail mailbox shows **Not syncing** with "Google refused the sign-in (<code>)", the Google client secret is wrong or was deleted. Make a new one in Google Cloud, save it in your password manager, and set it on the worker with "Rotating the client secrets" in "Connected mailboxes: Outlook and Gmail".

#### A business's own domain never verifies

**Symptom.** The domain stays at **Waiting for DNS**, or shows **Needs attention**.

**Likely cause.** The records are not visible yet, or were typed with the domain twice (for example `pm-bounces.yourbusiness.com.yourbusiness.com`). Nothing checks on its own: despite the page's text, there is no daily check and no email.

**Fix.** Compare the records at the DNS provider with the Host and Value on the page, then click **Check now**. The message says which record is missing ("DKIM found. The Return-Path record isn’t showing yet.", "Return-Path found. The DKIM record isn’t showing yet." or "Neither record is showing yet. DNS changes can take a few hours."). For **Needs attention**, read the error on the page.

#### Photos, voicemails or attachments are missing

**Symptom.** Picture texts, voicemail recordings, email attachments or imports fail. The log shows `SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is` or `Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY for the worker`, and `worker started` shows `storage` as `false`.

**Fix.** If `storage` already shows `true`, the key is set but may be wrong or deleted. Either way, copy the worker's secret key from the Supabase dashboard's **API Keys** page, check it with steps 5 to 7 of "Check the Postmark tokens and the Supabase key" in Fly Part 6, and set it on the worker only, with steps 12 to 16 of "Copy the publishable key and the secret key" in "The database: Supabase (hosted)".

You should see `storage` as `true` in the next `worker started` line. That only shows a key is set; the bucket check before it shows the key works.

#### "No key <id> to open this value"

**Symptom.** Texts, calls, voice tokens and mailbox syncs fail for existing clients. The log shows `No key <id> to open this value. Add the old key to WORKER_ENCRYPTION_KEYS_PREVIOUS.`

**Likely cause.** `WORKER_ENCRYPTION_KEY` was changed without keeping the old key. The worker sealed each client's Twilio credentials and mailbox sign-ins with the old key.

**Fix.** Put the old key back as a previous key, from your password manager. Start an import, paste `WORKER_ENCRYPTION_KEYS_PREVIOUS=<old encryption key>` (keep any keys already there, separated by commas), then press Return and Control-D.

```bash
fly secrets import --app handsfreeos-worker
```

You should see `worker started` again, and texts and calls work for existing clients.

Keep old keys there for good (see "Rotating the worker encryption key" in "Hosting: the API and the worker on Fly.io"). No tool re-seals stored values today, and Twilio credentials are sealed only once, when a client's first number is bought. If an old key is truly lost, mailboxes can be reconnected, but the affected clients' phone setup needs a developer.
