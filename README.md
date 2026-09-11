# HandsFreeOS

The operating system for running the customer side of a small business with as little manual work as possible. Milestone 1 is the foundation: multi-tenant accounts (organization → workspace → user), sign-in with password, Google and passkeys, invitations with fixed roles, and the command → event → audit pipeline every later feature rides on.

## What is in the repo

| Path                  | What it is                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js app (the product UI). Talks to Supabase Auth and the API only, never to the database.                                                |
| `apps/api`            | Fastify API. Every write is a command: validate → permission → handler → event + outbox + audit rows in one transaction. OpenAPI at `/docs`. |
| `apps/worker`         | Background worker. Drains the outbox and sends the invitation emails. Also hosts the development seed.                                       |
| `packages/core`       | Browser-safe domain: permissions, command kernel, commands, queries, zod schemas, typed errors.                                              |
| `packages/db`         | Drizzle schema mirror, the role-scoped database clients (`asUser`, `asWorker`) and shared test helpers.                                      |
| `packages/api-client` | Generated, typed client for the API (`openapi-typescript` + `openapi-fetch`).                                                                |
| `packages/ai`         | Swappable AI provider seam. Interface only until Milestone 4.                                                                                |
| `supabase/`           | Local stack config, SQL migrations (roles, tables, RLS, functions, triggers) and email templates.                                            |
| `design/m1`           | Clickable prototype sources for the Milestone 1 screens.                                                                                     |

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
pnpm db:seed          # demo data: the Go Biz Help agency, three client workspaces and their people
```

```bash
pnpm dev              # web http://localhost:3000, API http://127.0.0.1:4000, worker
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
pnpm test:e2e         # Playwright (Chromium); starts the API and web servers if none are running
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

## Deploying

`apps/api/Dockerfile` and `apps/worker/Dockerfile` build from the repository root:

```bash
docker build -f apps/api/Dockerfile -t hfos-api .
```

Each image needs only its runtime environment (documented at the top of `apps/api/src/env.ts` and `apps/worker/src/env.ts`). CI in `.github/workflows/ci.yml` runs lint, typecheck, every test suite and the browser tests against a local Supabase stack, checks that the generated API client is fresh, builds the web app and checks it ships no secret key, and scans the history for leaked secrets.

## Hosted project

The demo project lives in the Go Biz Help Supabase organization (ref `ybupfghakoszfcxhyrby`, region us-east-1). It signs tokens with ES256, which is the only algorithm the API accepts. Its non-secret values and the app role passwords are kept in the gitignored `.env.hosted` on the machine that set it up.

To bring the hosted database up to date with `supabase/migrations`:

```bash
supabase login && supabase link --project-ref ybupfghakoszfcxhyrby && supabase db push
```

After the first push, set the passwords for `hfos_api` and `hfos_worker` with `ALTER ROLE ... PASSWORD` (the migrations create them with local-only passwords), and configure Auth in the dashboard or with `supabase config push`: site URL and redirect URLs for the web app, the email templates from `supabase/templates`, passkeys with relying party id `handsfreeos.com` and the app's origin in the allowed origins, minimum password length 12, manual identity linking on, and the Google OAuth client. The API and worker connect through the session pooler (`aws-0-us-east-1.pooler.supabase.com:5432`, user `hfos_api.<ref>`); the direct host is IPv6 only.
