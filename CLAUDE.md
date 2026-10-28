# HandsFreeOS: notes for Claude

HandsFreeOS runs the customer side of a small business. It's a pnpm monorepo:

- `apps/web`: the Next.js web app;
- `apps/mobile`: the Expo phone app;
- `apps/api`: the Fastify API;
- `apps/worker`: the background worker;
- `apps/sync`: the PowerSync sync service;
- `apps/extension`: the browser extension, a test build for now;
- `apps/site`: the marketing site.

It all runs on Supabase Postgres (`supabase/`), with the domain logic in `packages/core`. `README.md` explains every part and how to run it locally.

## Read first

Read the doc for the area you're changing before writing code. Most have a section called "Rules worth knowing before changing anything". Those rules are settled, and so are the owner's decisions recorded in the docs and plans. Ask before going against one.

| Working on                                   | Read                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Add-ons                                      | `docs/addon-architecture.md`, then "Add-ons" below; `docs/addon-readiness-audit.md` is the audit behind it        |
| The Real Estate Agent add-on                 | `docs/realestate.md`, then `HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md`                                       |
| A business's own kinds of records, and links | `docs/relationships.md`                                                                                           |
| Deleting for good, and the Deleted bin       | `docs/deleting.md`                                                                                                |
| Forms, surveys and quizzes                   | `docs/forms.md`                                                                                                   |
| Documents to sign, and their templates       | `docs/documents.md`                                                                                               |
| Search everything, and settings search       | `docs/search.md`, then `HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md`                                                |
| The business's main offer                    | `docs/main-offer.md`, then `HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md` and the plans beside it                |
| What the phone keeps offline                 | `apps/sync/README.md`                                                                                             |
| Push notifications                           | `apps/worker/src/push/README.md`                                                                                  |
| The web app                                  | `apps/web/AGENTS.md`: this Next.js has breaking changes, so read its docs in `node_modules/next/dist/docs/` first |
| The public website                           | `apps/site/AGENTS.md`                                                                                             |
| Funnels in the AI teammate                   | `docs/funnels.md`, then `HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md`                                     |
| Feedback on the AI teammate's replies        | `HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md`, then "How the teammate works" in `docs/operations.md`           |
| The AI Sales Coach add-on                    | `docs/salescoach.md`, then `HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md`                                       |
| The Social Outreach add-on                   | `docs/outreach.md`, then `apps/extension/README.md` for the browser extension it works with                       |
| Partners: finding them, commissions, payouts | `HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md`, then decision 81 in `docs/outreach.md`                             |
| Affiliates: people who sell HandsFreeOS      | `HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md`, then `apps/site/AGENTS.md` for the website's `?ref=` links       |
| The browser extension                        | `apps/extension/README.md`                                                                                        |
| Messenger and Instagram, and ad attribution  | `docs/meta-messaging.md`; Meta's setup is "Facebook and Instagram messages: Meta" in `docs/operations.md`         |
| The phone app's store listings and releases  | `apps/mobile/store/README.md` and `release-checklist.md` beside it                                                |
| A milestone's decisions and build order      | the matching `HANDSFREEOS_*_PLAN.md` at the root                                                                  |
| Screen designs                               | `design/m1` to `design/m10`, `design/realestate` and `design/search`; the brand mark is in `design/brand`         |
| Hosting, providers, going live, and trouble  | `docs/operations.md`, over 11,000 lines, so jump to a section from its Contents                                   |
| HandsFreeOS video calls                      | `docs/video-calls.md`; setting up LiveKit is "Video calls: LiveKit" in `docs/operations.md`                       |
| Connecting Google and Outlook calendars      | `docs/calendar-setup.md`                                                                                          |

## How the system works

Don't route around these. The tests hold most of them.

- **Every change is a command.** Commands in `packages/core/src/commands` are the only way data changes. The kernel validates the input, checks the permission and runs the handler. It writes the event, outbox and audit rows in the same transaction. People, the system, workflows and the AI all go through it.
- **Security lives in the database.** Tables sit in schema `app`, where row-level security decides what each request sees. Nothing in the apps bypasses it; `packages/db/test` proves it.
- **The web talks to Supabase Auth and the API only**, never to the database.
- **Providers talk to the worker, never the API.** Provider keys belong to the worker, and the API refuses to start with one in its environment.
- **Screens ask for a permission** (from `workspace.get`), never a role.
- **The Assistant can do what a screen does.** A new screen command or setting row fails `packages/core/test/assistant-coverage.test.ts` until `packages/core/src/assistant/coverage.ts` covers it or says why not. See "Keeping the Assistant able to do everything" in `docs/operations.md`.
- **Side effects come from events**, which the worker takes from the outbox.
- **One copy of shared logic.** What the web and the phone both show or decide lives once, in `@hfos/core`. Money is worked out in `packages/core/src/money`, the push categories are in `push.ts`, and the Add-ons page's words are in `addons/words.ts`.

## Error messages

Every refusal a person can read explains the problem and, when anything can be done, how to fix it.

- **Say what's wrong, then what to do.** "Nobody on this calendar’s team does Duct cleaning. Tick someone under Who can do it in Settings → Calendars → Services." Name the screen or setting where the fix is.
- **Use what the request knows:** the name of the thing, the number, the ZIP code. Work out which cause it was rather than listing every possible one.
- **When the person can't fix it,** say who can ("Ask an owner of this business…") or what to try ("Try again in a minute.").
- **Plain words, short sentences, curly apostrophes.** No codes, ids or table names, and never blame.
- **Clients branch on `rule`, never on the words,** so wording can always improve. Tests check the rule, and only the parts of the message that matter.

## Add-ons

`docs/addon-architecture.md` is the guide; read it before touching add-on code. What matters most:

- **Start one with the generator,** never by copying another: `pnpm addon:new <id> --name "…" --summary "…" --category …`.
  - It writes the manifest, the server and worker halves, the first page, the migration and the test, and registers each in its list.
  - The id is 2 to 16 lowercase letters, and never reused.
  - A new add-on starts in `development`, offered to nobody.
- **Build on core's records.** Keep things as records of kinds the add-on manages, tied to customers with relationships. Timelines, tasks, files and search then work on them unchanged. Use its own tables only when records won't do: in schema `addon_<id>`, with `private.addon_table_policies()`.
- **Every operation goes through the kernel** (`defineAddonCommand`, `defineAddonQuery`), which refuses an add-on's work wherever it isn't on. Queue work with `scheduleAddonJob`, so turning the add-on off cancels it.
- **An add-on never touches another one, and core never points into one.**
  - An add-on hears about the business through events declared in its manifest.
  - Nothing in `app` or `platform` has a foreign key into `addon_<id>`; the catalogue test checks.
  - Only `apps/web/src/addons/registry.ts` imports an add-on's web folder; lint checks.
  - Pages open through `addonPage`, and panels on core's pages through `<AddonSlot>`.
  - A customer's portal pages are the registry's `portal` entry, declared in `ui.portal`, and act through `usePortal()`.
  - Signed-out public pages are the registry's `public` entry, declared in `ui.public`, and run only `<id>.public.*` operations.
- **The AI sees an operation only when it declares `ai`.** Look-ups and risk 0–1 changes run on their own. Risk 2–3 changes wait for a person's OK. Risk 4 is never offered.
- **An add-on answers searches through `manifest.search`:** a `defineAddonQuery` marked `route: false`, which core runs inside `search.everything` (and `search.kind`), with its failures kept to its own groups. The add-on's side is "Search" in `docs/addon-architecture.md`.
- **When an add-on's data changes shape,** add a `dataMigrations` step and bump `dataVersion`.
- **Check the doc's "Not yet" list first.** It covers an add-on's own credentials, webhook routes, workflow steps and billing. If an add-on needs one of these, build it in core as its own step. Don't work around it inside the add-on.
- **The owner's decisions are settled.** They're listed under "Rules worth knowing before changing anything": what asks first, what is kept, and who may delete.

## Database migrations

- **Add a new file in `supabase/migrations`**, named `<14-digit version>_<name>.sql`.
  - Number it above the newest file there, not by today's date: the versions run ahead of the calendar.
  - `scripts/migrations-check.mjs` refuses two files with the same version or name. CI runs it.
- **Keep the running code working.** Add tables and columns first, and remove old ones in a later migration.
- **Mirror tables, columns and enums in Drizzle** (`packages/db/src/schema`). The parity test fails when a mirrored table's columns, or any enum, drift from the database.
- **The hosted database gets a migration before `main` does.**
  - Deploys never run migrations, and a push to `main` deploys within minutes.
  - Follow "Apply new migrations" in `docs/operations.md`.
  - After applying one with the Supabase connector's `apply_migration`, set its recorded version back to the file's. See "If you used the Supabase connector instead" in the same doc.
- **Never run these against the hosted project:**
  - `supabase db push --include-seed`, `supabase db reset --linked` or `supabase config push`;
  - `pnpm db:reset`, `pnpm db:seed`, `pnpm env:local` or `pnpm test:e2e`, which are for the local stack only.

  Never change its tables, policies or functions by hand either.

## Sync: what the phone keeps offline

- **Every change to `apps/sync/sync-config.yaml`, even a comment, makes PowerSync copy everything again.**
  - Batch changes to it.
  - A change to what a stream sends is a new stream version, beside the old one.
- **The phone's local schema and design tokens are generated** by `node scripts/mobile-schema.mjs` and `node scripts/mobile-tokens.mjs`. CI checks both are fresh. Don't edit their output by hand.
- **`.github/workflows/sync.yml` runs only on `main` and nightly.** It covers the sync scenarios and the per-person limits. After a sync change, run it on your branch with `workflow_dispatch`.

## Commands

```bash
pnpm dev                          # web :3000, API :4000, worker :4100 (after "Run it locally" in README.md)
pnpm lint && pnpm typecheck && pnpm format:check
pnpm test                         # every suite, against the local Supabase stack
pnpm --filter @hfos/core exec vitest run test/addons   # one package's tests, or one folder or file of them
pnpm test:e2e                     # the browser tests (Playwright)
pnpm openapi                      # after changing a command or query: CI checks packages/api-client is fresh
node scripts/migrations-check.mjs
```

If `turbo` can't run where you are, run a package's script directly: `pnpm --filter @hfos/<package> run <script>`.

## Shipping

A push to `main` ships everything:

- the web app, on Vercel;
- the API and the worker, on Fly, plus the sync service when its config changed;
- the phone app, once CI passes, through EAS: a store build or an over-the-air update.

CI (`.github/workflows/ci.yml`) runs:

- lint, typecheck and formatting;
- the API client's freshness check and the migrations check;
- every test suite, and the seed;
- the web app's and the website's builds, and the browser tests.
