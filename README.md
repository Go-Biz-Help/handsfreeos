<img src="design/brand/handsfreeos-icon.png" width="72" alt="">

# HandsFreeOS

The operating system for running the customer side of a small business with as little manual work as possible. Milestone 1 is the foundation: multi-tenant accounts (organization → workspace → user), sign-in with password, Google and passkeys, invitations with fixed roles, and the command → event → audit pipeline every later feature rides on. Milestone 2 adds the CRM (customers, pipelines, leads, tasks, timeline, files, live updates, CSV import). Milestone 3 turns it into the place a business talks to its customers: a business number, carrier registration, texting and a shared inbox, with calls and email to follow. Milestone 4 adds the Assistant: an Ask HandsFreeOS panel in every workspace (⌘J) that answers questions about the business and gets work done through Claude, with some changes waiting for your OK. Milestone 5 adds the Calendar: one calendar that becomes personal, round robin, service, group, event, resource or dispatch through its settings, with Google and Outlook busy times and public booking pages.

## What is in the repo

| Path                  | What it is                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js app (the product UI). Talks to Supabase Auth and the API only, never to the database.                                                                                                                                                                                                                                                                 |
| `apps/api`            | Fastify API. Every write is a command: validate → permission → handler → event + outbox + audit rows in one transaction. OpenAPI at `/docs`.                                                                                                                                                                                                                  |
| `apps/worker`         | Background worker. Drains the outbox (invitation emails, CSV imports, file removal, buying numbers, sending texts and email), processes provider webhooks (Twilio, Postmark, Outlook) and scheduled jobs (reply reminders, mailbox syncs), and serves a small HTTP server for webhooks, voice tokens, number search and mailbox sign-in. Also hosts the seed. |
| `packages/core`       | Browser-safe domain: permissions, command kernel, commands, queries, zod schemas, typed errors.                                                                                                                                                                                                                                                               |
| `packages/db`         | Drizzle schema mirror, the role-scoped database clients (`asUser`, `asWorker`) and shared test helpers.                                                                                                                                                                                                                                                       |
| `packages/api-client` | Generated, typed client for the API (`openapi-typescript` + `openapi-fetch`).                                                                                                                                                                                                                                                                                 |
| `packages/ai`         | Swappable AI provider seam: the streaming contract, Anthropic's Claude and a scripted stand-in for tests.                                                                                                                                                                                                                                                     |
| `supabase/`           | Local stack config, SQL migrations (roles, tables, RLS, functions, triggers) and email templates.                                                                                                                                                                                                                                                             |
| `design/m1`–`m5`      | Design canvas sources for each milestone's screens.                                                                                                                                                                                                                                                                                                           |
| `docs/operations.md`  | Step-by-step setup for everything outside the code: Supabase, Fly.io, Vercel, Twilio, Postmark, Outlook and Gmail, local development, going live and troubleshooting.                                                                                                                                                                                         |

## Run it locally

You need Node 22 (see `.nvmrc`), pnpm 12, Docker and the Supabase CLI.

```bash
brew install pnpm supabase/tap/supabase
```

```bash
brew install colima docker && colima start --cpu 4 --memory 8   # or use Docker Desktop
```

From a fresh clone:

```bash
pnpm install
```

```bash
pnpm supabase:start   # local Postgres, Auth and Mailpit on ports 54421–54429 (the first run pulls images)
```

```bash
pnpm env:local        # writes .env.local and the per-app env files from `supabase status`
```

```bash
pnpm db:seed          # demo data: the Go Biz Help agency, three client workspaces and their people;
                      # Lone Star also gets a business number, conversations, calls, email and two Assistant chats
```

```bash
pnpm dev              # web http://localhost:3000, API http://127.0.0.1:4000, worker http://127.0.0.1:4100
```

Sign in at http://localhost:3000/sign-in with any seeded account. The password for all of them is `HandsFree-Demo-2026`.

| Account                      | Who                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| chris@gobizhelp.test         | Owner of the Go Biz Help organization (the agency). Reaches every client workspace.   |
| dale@lonestarhvac.test       | Owner of Lone Star HVAC & Roofing                                                     |
| priya@lonestarhvac.test      | Admin of Lone Star HVAC & Roofing                                                     |
| marco@lonestarhvac.test      | Member of Lone Star HVAC & Roofing                                                    |
| renee@bayouplumbing.test     | Owner of Bayou Plumbing Co.                                                           |
| tom@summitroofing.test       | Owner of Summit Roofing                                                               |
| riley@northstarelectric.test | Owner of Northstar Electric, a separate organization that sees nothing of Go Biz Help |

Useful local URLs: Mailpit (every email the stack sends) http://localhost:54424, Supabase Studio http://localhost:54423, API docs http://127.0.0.1:4000/docs.

Good to know:

- Open the web app on `localhost`, not `127.0.0.1`. Passkeys are bound to the `localhost` relying party.
- New accounts confirm their email first. Locally the confirmation link lands in Mailpit.
- `pnpm db:reset` wipes the database, re-applies every migration and seeds again.
- Milestone 2 uses Realtime and Storage. A local stack started before those migrations existed must be restarted once (`pnpm supabase:stop && pnpm supabase:start`) so the Realtime service creates its tables; the migration that adds the live-updates policy warns instead of failing when they are missing.
- Texting runs against a fake phone carrier locally: buying a number, carrier approval, sending, delivery receipts and inbound texts all happen in memory inside the worker, so nothing costs money. The reminder email for an unanswered customer waits the workspace's 10 minutes; set `UNANSWERED_ALERT_MS=8000` in `apps/worker/.env` to see it sooner.
- The Assistant needs an Anthropic API key to answer: add `ANTHROPIC_API_KEY=<your key>` to `apps/worker/.env` and restart `pnpm dev`, or its panel says it isn't set up. "Trying the Assistant" in `docs/operations.md` explains how to make a separate local key. `pnpm env:local` keeps the line when it rewrites the file.
- Calendars run against a stand-in locally: the Google and Outlook buttons in Settings → My calendar open a stand-in sign-in page on the worker, so no Google or Microsoft account is needed, and busy times and events live in the worker's memory. "Trying the calendar locally" in `docs/operations.md` shows how to add busy time and see what HandsFreeOS wrote.
- The browser tests start their own worker on port 4100 with an 8-second reminder; stop `pnpm dev` first so the tests get it.
- Docker via Colima: the `pnpm supabase:*` scripts point the CLI at Colima's socket for you. If you call `supabase` directly, export `DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"` first.
- The local stack uses ports 54421–54429 (API 54421, Postgres 54422, Studio 54423, Mailpit 54424, SMTP 54425) so it does not collide with other projects' stacks on the default 543xx ports.

### Google sign-in (optional locally)

Create a "Web application" OAuth client in Google Cloud Console with the origin `http://localhost:3000` and the redirect URI `http://127.0.0.1:54421/auth/v1/callback`. Put the client id and secret in `.env` (created from `.env.example` on first start), then restart the stack:

```bash
pnpm supabase:stop && pnpm supabase:start
```

## Day to day

```bash
pnpm dev              # everything, with reload
```

```bash
pnpm lint && pnpm typecheck
```

```bash
pnpm test             # unit + database (RLS) + API + worker suites, against the local stack
```

```bash
pnpm test:e2e         # Playwright (desktop Chromium and a 390 px phone project); starts the API and web servers if none are running
```

```bash
pnpm openapi          # regenerate packages/api-client after changing a command or query
```

Run `pnpm --filter @hfos/web exec playwright install chromium` once before the browser tests.

## How the pieces fit

- **Security lives in the database.** App tables sit in schema `app`, which Supabase's REST API never exposes. The API connects as `hfos_api` and switches to the `authenticated` role with the verified JWT claims for every transaction, so row-level security decides what each request can see. The worker connects as `hfos_worker` and is scoped to one tenant per job. Nothing in the apps can bypass RLS; the database suite in `packages/db/test` proves it.
- **One pipeline for every change.** The commands in `packages/core/src/commands` are the only way data changes. Each declares its input, permission, scope and events. The kernel validates, checks the permission, runs the handler and writes the event, outbox and audit rows in the same transaction, tagged with the request's correlation id.
- **Events drive side effects.** The worker claims outbox rows with `FOR UPDATE SKIP LOCKED`, runs the handler for the event type, retries with backoff, and records its own system events (for example `invitation.sent`) so the audit log tells the whole story.
- **Auth is Supabase Auth.** Email + password with confirmations on, Google, and passkeys added from Account settings after sign-up. The API verifies ES256 tokens against the project's JWKS and refuses to start if a secret key is in its environment.
- **Live screens ride the event stream.** A database trigger broadcasts every `app.events` row (ids only, never data) to the private Realtime topic `workspace:<id>`; RLS on `realtime.messages` admits members of that workspace. The browser drops its own echoes by correlation id and refetches through the API, so nothing in the browser reads tables.
- **Files stay behind reserved paths.** `file.begin_upload` reserves a server-made object path in the private `attachments` bucket; the browser uploads there with its own session (Storage RLS admits only that path), `file.confirm` marks it ready, and only the worker ever deletes an object. The CSV import works the same way through the `imports` bucket.
- **Providers talk to the worker, never the API.** Twilio's webhooks land on the worker's HTTP server, are checked against the signing account's token and the public URL, stored once per provider id, answered at once, and processed by the worker's loops as system commands. Each client workspace has its own Twilio subaccount, whose token is sealed with the worker's key before it reaches the database; the API refuses to start with any provider key in its environment.
- **The worker is an actor too.** Imports run `person.create` and friends as the `system` actor inside the job's workspace: the same validation, duplicate rules, timeline entries and audit rows as manual entry, committed in batches with a heartbeat so progress is live and a crashed run resumes.

## Deploying

`apps/api/Dockerfile` and `apps/worker/Dockerfile` build from the repository root:

```bash
docker build -f apps/api/Dockerfile -t hfos-api .
```

Each image needs only its runtime environment (documented at the top of `apps/api/src/env.ts` and `apps/worker/src/env.ts`). Both run on Fly.io (`apps/api/fly.toml`, `apps/worker/fly.toml`); `.github/workflows/deploy.yml` deploys them after CI passes on `main` once the `FLY_API_TOKEN` secret exists. The one-time setup is in `docs/operations.md`. CI in `.github/workflows/ci.yml` runs lint, typecheck, every test suite and the browser tests against a local Supabase stack, checks that the generated API client is fresh, builds the web app and checks it ships no secret key, and scans the history for leaked secrets.

## Hosted project

The demo project lives in the Go Biz Help Supabase organization (ref `ybupfghakoszfcxhyrby`, region us-east-1). It signs tokens with ES256, which is the only algorithm the API accepts. Its non-secret values and the app role passwords are kept in the gitignored `.env.hosted` on the machine that set it up.

To bring the hosted database up to date with `supabase/migrations`:

```bash
supabase login && supabase link --project-ref ybupfghakoszfcxhyrby && supabase db push
```

After the first push, set the passwords for `hfos_api` and `hfos_worker` with `ALTER ROLE ... PASSWORD` (the migrations create them with local-only passwords), and configure Auth in the dashboard (never with `supabase config push`, which copies the local settings over the hosted ones): site URL `https://app.handsfreeos.com` and its `/auth/callback` and `/auth/confirm` redirect URLs, the email templates from `supabase/templates`, passkeys with relying party id `handsfreeos.com` and `https://app.handsfreeos.com` in the allowed origins, minimum password length 12, manual identity linking on, and the Google OAuth client. The API and worker connect through the session pooler (`aws-0-us-east-1.pooler.supabase.com:5432`, user `hfos_api.<ref>`); the direct host is IPv6 only.
