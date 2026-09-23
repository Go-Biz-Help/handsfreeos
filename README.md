<img src="design/brand/handsfreeos-icon.png" width="72" alt="">

# HandsFreeOS

The operating system for running the customer side of a small business with as little manual work as possible. Milestone 1 is the foundation: multi-tenant accounts (organization → workspace → user), sign-in with password, Google and passkeys, invitations with fixed roles, and the command → event → audit pipeline every later feature rides on. Milestone 2 adds the CRM (customers, pipelines, leads, tasks, timeline, files, live updates, CSV import). Milestone 3 turns it into the place a business talks to its customers: a business number, carrier registration, texting and a shared inbox, with calls and email to follow. Milestone 4 adds the Assistant: an Ask HandsFreeOS panel in every workspace (⌘J) that answers questions about the business and gets work done through Claude, with some changes waiting for your OK. Milestone 5 adds the Calendar: one calendar that becomes personal, round robin, service, group, event, resource or dispatch through its settings, with Google and Outlook busy times and public booking pages. Milestone 6 adds workflows: automatic follow-ups built in three editors that all change the same workflow (a step list, a canvas, and Describe, where Claude turns a sentence into steps). It also adds the knowledge base that AI steps and the Assistant write from, and agency templates and knowledge packs that Go Biz Help pushes to its client businesses. Milestone 7 adds the AI teammate: one AI assistant per business, with a name like "Ava", that answers the business's customers by text, email and a new website chat, qualifies and books them, and hands a conversation to a person when it should. Each message waits for a person's OK until it has earned enough approvals. Milestone 8 turns Home into the Action Center: one ranked list of what needs attention, with the money affected at the top, the safe items (confirmation requests and follow-up nudges) handled by HandsFreeOS itself, a morning summary email, and the same list behind the Assistant's "What needs my attention?". Milestone 9 adds Money: a catalogue, estimates a customer approves with their name, invoices they pay on their own link, deposits taken when they book, maintenance plans that bill themselves, and reminders that chase an unpaid bill without anybody remembering to. Each business connects its own Stripe or Square account and the money settles in its own balance — HandsFreeOS never holds it. Milestone 11 adds Migrations: moving a business here from the CRM it uses today, GoHighLevel first. It looks before it moves, counts what is there and says how sure it is of each count, joins the same customer arriving from two places without ever guessing on a name, brings history across with the dates it really happened on, and can be taken back without touching anything somebody has changed since. Milestone 13 adds the support desk and the admin side: mail to support@handsfreeos.com becomes a ticket inside HandsFreeOS rather than landing in a mailbox anybody signs into, customers can ask for help from inside the app, and `/admin` holds the queue, the businesses, what has failed lately, and the support people who answer — with a read-only, time-limited, audited way to look at a business when that is what it takes to answer. Milestone 18 lets the AI teammate finish the job while the customer is still in the conversation: check the service area, join a waitlist, book repeat visits, open and close deals, and look up bills and quotes. Anything that asks a customer for money (a pay link, a new bill, a quote, a plan) waits for an owner's OK. Staff hear about hand-offs on the phone app and by text.

## What is in the repo

| Path                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`               | Next.js app (the product UI). Talks to Supabase Auth and the API only, never to the database.                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/site`              | The public website at `handsfreeos.com`: the home page, pricing, the phone-app page, the privacy policy, the terms and support. A static Next.js app with no environment variables, deployed as its own Vercel project so a copy change never rebuilds the product.                                                                                                                                                                                                                  |
| `apps/api`               | Fastify API. Every write is a command: validate → permission → handler → event + outbox + audit rows in one transaction. OpenAPI at `/docs`.                                                                                                                                                                                                                                                                                                                                         |
| `apps/worker`            | Background worker. Drains the outbox (invitation emails, CSV imports, file removal, buying numbers, sending texts and email), processes provider webhooks (Twilio, Postmark, Outlook) and scheduled jobs (reply reminders, mailbox syncs), runs the workflow engine, the knowledge base's website scans and the AI teammate, and serves a small HTTP server for webhooks, voice tokens, number search, mailbox sign-in, the booking pages and the website chat. Also hosts the seed. |
| `apps/sync`              | The sync service for the phone app: the PowerSync Service's config and Sync Streams (what each phone keeps), `pnpm sync:start` and `pnpm sync:stop` beside the local stack, its Fly config, and the sync scenarios, where PowerSync's Node client plays phones against the real service and API.                                                                                                                                                                                     |
| `packages/core`          | Browser-safe domain: permissions, command kernel, commands, queries, zod schemas, typed errors.                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/db`            | Drizzle schema mirror, the role-scoped database clients (`asUser`, `asWorker`) and shared test helpers.                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/api-client`    | Generated, typed client for the API (`openapi-typescript` + `openapi-fetch`).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/ai`            | Swappable AI provider seam: the streaming contract, Anthropic's Claude and a scripted stand-in for tests.                                                                                                                                                                                                                                                                                                                                                                            |
| `supabase/`              | Local stack config, SQL migrations (roles, tables, RLS, functions, triggers) and email templates.                                                                                                                                                                                                                                                                                                                                                                                    |
| `design/m1`–`m9`         | Design canvas sources for each milestone's screens.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/operations.md`     | Step-by-step setup for everything outside the code: Supabase, Fly.io, Vercel, Twilio, Postmark, Outlook and Gmail, the AI teammate and website chat, taking money with Stripe and Square, local development, going live and troubleshooting.                                                                                                                                                                                                                                         |
| `docs/calendar-setup.md` | The short path to Google Calendar and Outlook calendars: the Entra permission, the separate Google Cloud project, the two worker secrets and how to check it. The long version lives in `docs/operations.md`.                                                                                                                                                                                                                                                                        |

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
                      # Lone Star also gets a business number, conversations, calls, email, two Assistant chats,
                      # four calendars with two weeks of appointments, and a booking site at /book/lone-star-hvac;
                      # Glow Red Light Studio books its four red light beds with no staff at /book/glow-studio;
                      # Lone Star has live workflows with past runs and a filled-in knowledge base, and Go Biz Help
                      # has a workflow template pushed to Lone Star and Bayou and an HVAC FAQs pack pushed to Bayou;
                      # Lone Star's AI teammate Ava is in training wheels, and Dale's Action Center opens on a hot
                      # lead waiting 11 minutes, a lead nobody answered, visits to confirm and the rest of the list;
                      # its money runs on a stand-in Stripe account and a Square one, with a catalogue, a paid
                      # invoice and its receipt, one ten days overdue, estimates waiting, declined and unsent, a
                      # deposit paid to hold a duct clean, a time still held while a customer pays, and two plans
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
- Workflow AI steps, Describe, website scans and Try it use the Assistant's model and daily limit. Without a key they fall back: AI steps take their fallback, a scan turns each page into one suggested article, and Describe and Try it say the AI isn't set up. `ASSISTANT_PROVIDER=scripted` in `apps/worker/.env` swaps in the free scripted stand-in the browser tests use (the next `pnpm env:local` removes that line). "Try workflows and the knowledge base locally" in `docs/operations.md` shows how to skip a wait and scan the stand-in website.
- Calendars run against a stand-in locally: the Google and Outlook buttons in Settings → My calendar open a stand-in sign-in page on the worker, so no Google or Microsoft account is needed, and busy times and events live in the worker's memory. "Trying the calendar locally" in `docs/operations.md` shows how to add busy time and see what HandsFreeOS wrote.
- Bookings and website chats use Cloudflare Turnstile's always-pass test keys locally (`pnpm env:local` writes them), so the check that a person is writing works as in production. It goes through Cloudflare, so it needs the internet.
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

## The AI teammate and website chat

Each business can have one AI teammate, set up under **AI teammate** in the sidebar. It has a name, says it's AI in its first message or only when asked, and never claims to be a person. Its skills switch on and off: message new leads, answer from the knowledge base, ask qualifying questions and book on the business's calendars. It answers texts, email and the website chat.

- **Training wheels, then automatic.** Every reply, booking, move or cancellation waits as a draft for a person's OK, in the inbox and on **Approvals**, until it has enough approvals (20 by default). Then it answers on its own. **Switch to automatic now** and **Back to training** are always there.
- **Guardrails in code, not only in the prompt.** `checkTeammateReply` (`packages/core/src/ai-team/guardrails.ts`) checks every reply's links, numbers, prices, booking claims and disclosure. A reply that fails is rewritten once, then goes to a person. Emergencies, legal threats and refunds go straight to **Needs a person**, with a note and an email.
- **An actor like any other.** It runs in the worker (`apps/worker/src/ai-team`) as an `ai_employee` actor through the same command pipeline people use, with its own tools that reach only the conversation it's answering. The timeline and audit log say "Ava (AI)", and name who approved each message.
- **Follow-ups on a schedule.** When a customer goes quiet after it asks something, it follows up 4 hours later, then on days 1, 2, 4, 7, 10, 14, 21 and 30, then monthly for 6 months, and stops the moment they reply, book or say no. **Settings** → **Automations** changes the schedule and holds every other automation's switch.
- **Website chat.** **Settings** → **Website chat** lists the sites the chat button may show on, and gives the one line a business pastes on its site. The chat window is a page on our own site (`/chat/<key>`), which browsers show only inside those sites (`frame-ancestors`). Messages land in the inbox, replies stream back live, and Cloudflare Turnstile checks the first message invisibly.

To try it locally, add `ASSISTANT_PROVIDER=scripted` (or your own Anthropic key) to `apps/worker/.env`, restart `pnpm dev`, and set up a teammate in any workspace. For the website chat, `node apps/web/e2e/fixtures/chat-site.mjs 4191` serves a stand-in business website: add `http://127.0.0.1:4191` to the widget's sites, then open `http://127.0.0.1:4191/?snippet=` followed by the snippet, URL-encoded. "The AI teammate and website chat" in `docs/operations.md` covers setting it up for a client, the hand-off emails, the new settings (`CHAT_IP_KEY`, the Turnstile keys, `ASSISTANT_DAILY_TOKENS` and `CHAT_LOOKUP_CACHE_MS`) and going live.

## The Action Center

Home is one ranked list of what needs attention, with the money affected at the top: hot leads, leads nobody answered, leads gone quiet, leads with no next step, visits not confirmed, approvals, customers waiting and overdue tasks. Each card says why it ranks where it does, and offers Handle, **Let HandsFreeOS Handle**, Assign, Snooze and Dismiss, each with Undo.

- **Detected where the facts change.** `withAttention` (`apps/worker/src/attention`) reconciles the subjects an event touched in the same transaction, at exact recheck times, and in an hourly sweep. Each row keeps a fingerprint of the facts behind it, so a dismissed item stays dismissed until they change, and items clear themselves. The rules are pure functions in `packages/core/src/attention` — one detector per kind, plus the score, the folding and the settings — so M9's money kinds are one line in the registry.
- **It handles the safe ones.** A confirmation request for tomorrow's visit, and a follow-up nudge in the business's own words. Both respect consent, quiet hours, a 60-minute cancel window, a 14-day cooldown per lead, and a list of reasons to leave someone alone; nudges wait until an owner has read the wording. Everything else asks first. Every skip is recorded, so the card says why nothing went out.
- **Customers confirm by replying C**, or with a button on their booking page (never a plain link: email scanners open those). YES confirms too while an ask is open. CANCEL is never asked for — for the carriers it means STOP.
- **It emails.** A morning summary at 7:00 local, per person, only when they have something, and one urgent email per item for a hot lead, an unanswered lead or a customer waiting. It replaces the old unanswered-message email, so nobody gets two.
- **One engine.** The Assistant's "What needs my attention?" reads the same query as Home, in the same order, and can handle, snooze, dismiss or assign an item through a confirm card.

"The Action Center" in `docs/operations.md` covers the kinds and thresholds, every guard before an automatic message, confirming visits, both emails, the test routes and what to agree with a client before turning it on.

## Money

**Money** in the sidebar is what the business has quoted, what it is owed and what has come in: estimates, invoices, payments and maintenance plans, with the catalogue under **Settings** → **Products**. An estimate goes out by text and email, the customer approves it by typing their name, and it becomes an invoice in one press. An invoice is paid on the customer's own link — card or bank transfer — and the receipt goes out on its own.

- **Each business signs into its own account.** **Settings** → **Payments** connects Stripe or Square by OAuth, and a business can connect several at once and pick which one a document is paid into. **The money settles in the business's own balance.** They are the merchant of record, the payouts and the chargebacks are theirs, the fees are theirs, and they can revoke us from their own dashboard at any time. HandsFreeOS never touches the money and never holds a card number: the customer's card details go straight to the provider from the customer's own browser, and only a token comes back.
- **Deposits at booking.** A calendar can ask for a share of the price before it will hold a time (**Settings** → **Calendars** → **Payments**). The time is **held**, not booked, for fifteen minutes; the card is **authorised, not charged**, and is captured only in the same transaction that confirms the slot. If the slot goes while the customer is typing, nothing is taken — and a bank transfer, which cannot be held, is sent back in full at once. A hold nobody pays expires and the time goes back on the calendar.
- **Plans bill at the provider.** A maintenance plan is a Stripe or Square subscription, so their engine brings the retries, the card updater and the re-authentication. A plan **starts waiting on the customer to put a card on it** from their own page (`/p/<ref><code>`), because neither provider will bill a customer they have no card for. Each cycle they bill lands here as an invoice and a payment, so a plan's money is on the same ledger as everything else.
- **Reminders, and the card on Home.** An invoice's ladder runs three days before it is due, on the day, and three, seven and fourteen days after, at 9 AM where the business is, respecting consent and quiet hours. An estimate gets one nudge. When an invoice is still unpaid a day after its due day, and when an estimate has been out five days unanswered, the Action Center opens a card — never automatic and never handed to the AI teammate: both buttons end with a person reading the words and pressing send.
- **One ledger, in the database.** `app.estimates`, `app.invoices`, `app.payments`, `app.refunds` and `app.subscriptions` (migrations `20260920000100`–`20260920001000`). A document that has gone out keeps its number, its tax and its totals; what was paid is written only by HandsFreeOS; a refund gives money back and never puts it back on the bill, so a refunded invoice stays paid and billing again means voiding it and sending a new one; and a provider's tokens are sealed with the worker's key and never granted to a person. Money is worked out once, in `packages/core/src/money`, so the editor, the customer's page, the printed copy and the reports all add up the same way.

Locally everything runs against a **stand-in provider** (`apps/worker/src/payments/fake.ts`) — no Stripe or Square account needed. The connect buttons in **Settings** → **Payments** open its own sign-in page on the worker, and paying opens its own payment page. Type `4242 4242 4242 4242` to pay, `4000 0000 0000 0002` to be declined, `4000 0000 0000 0341` for a card that saves and then fails when a plan bills it, and `000123456789` for a bank transfer that settles when you ask. Three worker routes stand in for what you would otherwise have to wait for. `POST /test/money/provider-event` makes the stand-in settle a transfer, fail one, raise a dispute, bill a plan's cycle or revoke an account — posting its properly signed webhook at our own endpoint — `POST /test/money/run-due` runs the money jobs that are waiting, and `POST /test/money/link` hands back a customer's own link for a document or a plan — the same link an owner copies with **Copy link** on the estimate, invoice or plan page. All three need `{ "workspaceId": "…" }` and are refused in production. "Money: Stripe and Square" in `docs/operations.md` covers what to do at each provider before a real payment.

## Your own side menu

The menu down the left is each person's own. **Settings** → **Side menu** → **Edit menu** moves a place up or down, folds the ones you rarely open into a **group** — one row that opens beside the sidebar when the pointer rests on it or you press it, and in place in the phone's drawer — or takes a place out of the menu altogether. **Use suggested groups** does the tidying in one press: the everyday places stay out and the rest go under **More**, nine rows instead of fifteen. The menu itself holds only places to go: arranging it is something done once, and a row for it would be read past every day. Home and Settings can be moved or grouped but never hidden, so there is always a way home and always a way back to the editor.

The arrangement is kept with the account (`users.settings.menu`), so every device you sign in on shows the same menu, and the long list scrolls on its own — Get help and your account stay at the foot of the sidebar. A place you hid is not gone: search and links still open it, and the editor lists it under **Hidden**. A section that ships after you arranged your menu appears on its own, beside the neighbour it belongs next to (`packages/core/src/account/menu.ts`).

## Relationships

A business can keep its own kinds of records — pets, vehicles, properties, units, students, equipment, or anything it names — and connect any two records: a customer to their pets, a parent to a child, a tenant to a unit, a person to the businesses they work at, two spouses. **Settings** → **Relationships** makes them from starters in one press or from a short form, and **Settings** → **Fields** gives customers, companies and each kind their own fields.

- **Nothing is one-to-one unless a business says so.** Every type starts many to many; a business picks "one" for a side only when there can never be more, and the database holds it to that (`private.check_relationship`, with a lock per record so two people can't both slip one past).
- **Both directions, one row.** A customer's page lists their vehicles, and each vehicle's page lists all its owners, from the same pair. Adding or removing one writes on both timelines.
- **A record is a full record.** Each pet, vehicle or property has its own page under **Customers**, with its fields, notes, timeline, tasks, appointments and files, and the conversations of the people it's connected to.

`docs/relationships.md` covers the tables, the rules and what isn't done yet.

## How the pieces fit

- **Security lives in the database.** App tables sit in schema `app`, which Supabase's REST API never exposes. The API connects as `hfos_api` and switches to the `authenticated` role with the verified JWT claims for every transaction, so row-level security decides what each request can see. The worker connects as `hfos_worker` and is scoped to one tenant per job. Nothing in the apps can bypass RLS; the database suite in `packages/db/test` proves it.
- **One pipeline for every change.** The commands in `packages/core/src/commands` are the only way data changes. Each declares its input, permission, scope and events. The kernel validates, checks the permission, runs the handler and writes the event, outbox and audit rows in the same transaction, tagged with the request's correlation id.
- **Events drive side effects.** The worker claims outbox rows with `FOR UPDATE SKIP LOCKED`, runs the handler for the event type, retries with backoff, and records its own system events (for example `invitation.sent`) so the audit log tells the whole story.
- **Auth is Supabase Auth.** Email + password with confirmations on, Google, and passkeys added from Account settings after sign-up. The API verifies ES256 tokens against the project's JWKS and refuses to start if a secret key is in its environment.
- **Live screens ride the event stream.** A database trigger broadcasts every `app.events` row (ids only, never data) to the private Realtime topic `workspace:<id>`; RLS on `realtime.messages` admits members of that workspace. The browser drops its own echoes by correlation id and refetches through the API, so nothing in the browser reads tables.
- **Files stay behind reserved paths.** `file.begin_upload` reserves a server-made object path in the private `attachments` bucket; the browser uploads there with its own session (Storage RLS admits only that path), `file.confirm` marks it ready, and only the worker ever deletes an object. The CSV import works the same way through the `imports` bucket.
- **Providers talk to the worker, never the API.** Twilio's webhooks land on the worker's HTTP server, are checked against the signing account's token and the public URL, stored once per provider id, answered at once, and processed by the worker's loops as system commands. Each client workspace has its own Twilio subaccount, whose token is sealed with the worker's key before it reaches the database; the API refuses to start with any provider key in its environment.
- **The worker is an actor too.** Imports run `person.create` and friends as the `system` actor inside the job's workspace: the same validation, duplicate rules, timeline entries and audit rows as manual entry, committed in batches with a heartbeat so progress is live and a crashed run resumes.
- **A workflow is one definition.** Steps, Canvas, Describe and the Assistant all change the same tree of steps, and only through patch ops (`packages/core/src/workflows`), so nothing is lost between editors. Published versions never change. The worker's engine runs each step as a `workflow` actor through the same command pipeline people use, so the customer's timeline says "Workflow: <name>" and the audit log says "via workflow".

## Deploying

`apps/api/Dockerfile` and `apps/worker/Dockerfile` build from the repository root:

```bash
docker build -f apps/api/Dockerfile -t hfos-api .
```

Each image needs only its runtime environment (documented at the top of `apps/api/src/env.ts` and `apps/worker/src/env.ts`). Both run on Fly.io (`apps/api/fly.toml`, `apps/worker/fly.toml`); `.github/workflows/deploy.yml` deploys them after CI passes on `main` once the `FLY_API_TOKEN` secret exists. The sync service (`apps/sync/fly.toml`, PowerSync's own image pinned by digest, with its own small Postgres in `apps/sync/storage/fly.toml`) deploys in the same workflow once its Fly app has its secrets, and only when its config changed; `.github/workflows/sync-health.yml` checks it every hour. "Sync service: PowerSync on Fly" in `docs/operations.md` sets it up. The one-time setup is in `docs/operations.md`. CI in `.github/workflows/ci.yml` runs lint, typecheck, every test suite and the browser tests against a local Supabase stack, checks that the generated API client is fresh, builds the web app and checks it ships no secret key, and scans the history for leaked secrets. Two more workflows keep the 45-minute job's room: `.github/workflows/sync.yml` runs the sync scenarios and the per-person limits against a real local PowerSync (on `main` and nightly), and `.github/workflows/server-images.yml` builds the API and worker images and fails if either carries the phone's native packages. The phone app ships the same way, through EAS: `.github/workflows/mobile-release.yml` asks EAS to run `apps/mobile/.eas/workflows/deploy-production.yml` on the commit CI just passed, which fingerprints the native side and either builds and submits to TestFlight and Play's internal testing track or publishes an over-the-air update instead — per platform, deciding for itself. Off `main`, `apps/mobile/.eas/workflows/preview-update.yml` publishes a preview update for every branch and `preview-build.yml` beside it makes an installable build when a pull request is labelled `mobile-build`. "Phone Part 4" in `docs/operations.md` sets it up.

## Hosted project

The demo project lives in the Go Biz Help Supabase organization (ref `ybupfghakoszfcxhyrby`, region us-east-1). It signs tokens with ES256, which is the only algorithm the API accepts. Its non-secret values and the app role passwords are kept in the gitignored `.env.hosted` on the machine that set it up.

To bring the hosted database up to date with `supabase/migrations`:

```bash
supabase login && supabase link --project-ref ybupfghakoszfcxhyrby && supabase db push
```

After the first push, set the passwords for `hfos_api` and `hfos_worker` with `ALTER ROLE ... PASSWORD` (the migrations create them with local-only passwords), and configure Auth in the dashboard (never with `supabase config push`, which copies the local settings over the hosted ones): site URL `https://app.handsfreeos.com` and its `/auth/callback` and `/auth/confirm` redirect URLs, the email templates from `supabase/templates`, passkeys with relying party id `handsfreeos.com` and `https://app.handsfreeos.com` in the allowed origins, minimum password length 12, manual identity linking on, and the Google OAuth client. The API and worker connect through the session pooler (`aws-0-us-east-1.pooler.supabase.com:5432`, user `hfos_api.<ref>`); the direct host is IPv6 only.
