# apps/sync — what each phone keeps

The PowerSync Service (Open Edition 1.26.1) keeps a copy of each business on the phones of the people who work in it. Phones **read** through it; every change still goes through the API's commands. This folder holds its configuration, the scripts that run it beside the local Supabase stack, its Fly config, and the end-to-end sync scenarios. "Sync service: PowerSync on Fly" in `docs/operations.md` sets it up on Fly and says what to do when it needs attention.

| File                             | What it is                                                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.yaml`                   | The service: source database, its own storage, Supabase JWT checks, admin token. Everything that differs between a laptop and Fly comes from the environment.                                                                                                                      |
| `sync-config.yaml`               | The Sync Streams (edition 3): which rows and columns each person's phone gets.                                                                                                                                                                                                     |
| `scripts/start.sh`               | `pnpm sync:start`                                                                                                                                                                                                                                                                  |
| `scripts/stop.sh`                | `pnpm sync:stop`                                                                                                                                                                                                                                                                   |
| `scripts/status.mjs`             | The service's health in words, from inside its machine or container (`docker exec hfos-sync node /config/status.mjs`); exits 1 when its slot is in danger, it can't reach the database, or a new sync config is stuck copying. The Deploy and Sync health workflows run it on Fly. |
| `scripts/compaction-machine.mjs` | Creates or replaces the Fly machine that runs PowerSync's `compact` about once a day, with the service's image, settings and files.                                                                                                                                                |
| `fly.toml`                       | `handsfreeos-sync` on Fly: PowerSync's image pinned by digest, these files written into the machine, one machine that never stops, the health check, `sync.handsfreeos.com`.                                                                                                       |
| `storage/fly.toml`               | `handsfreeos-sync-storage`: PowerSync's own Postgres 17 on a Fly volume, reachable only over Fly's private network. No backups: it can be rebuilt.                                                                                                                                 |
| `src/shape.ts`                   | Every stream's client tables, their columns and database types, read from `sync-config.yaml`: the phone's contract records them, the scenarios' phones declare them, and the app's schema is generated from them (`scripts/mobile-schema.mjs`).                                    |
| `test/`                          | The sync scenarios (`pnpm --filter @hfos/sync test:scenarios`, with `pnpm sync:start` running): PowerSync's Node client plays phones against this service and the real API.                                                                                                        |

## Running it locally

```sh
pnpm supabase:start          # the local stack, with migrations through 0060
pnpm sync:start              # PowerSync on http://127.0.0.1:54430, ready once its first copy is done
pnpm sync:stop               # removes it, its storage and its replication slot
```

- **Storage.** PowerSync keeps its working data in a small Postgres of its own (`hfos-sync-storage`), never in the Supabase database: spike 1b measured ~7× the data in WAL per full copy in the same database, and a lost slot. Nothing in it needs keeping — but a running one is reused, so `sync:start` alone is not a fresh copy; `sync:stop` removes it and the next start copies the database again (about 10 s locally). That pair is also the cure after a `pnpm db:reset`, which leaves a running service holding a password the rebuilt `hfos_sync` role no longer has.
- **The replication role** is `hfos_sync` (migration 0057), which has no password in the migrations. `sync:start` gives it a local-only one. At go-live it gets a real one, set by hand.
- **The slot** is `hfos_sync_<n>_<hash>`. A slot held by a stopped service keeps WAL until `max_slot_wal_keep_size` (512 MB locally), then is lost. So `sync:stop` drops it.
- **Tokens** are the phone's Supabase access token, checked against Auth's ES256 keys (`/auth/v1/.well-known/jwks.json`). `auth.user_id()` in the streams is the token's `sub`. PowerSync refuses tokens older than an hour, so Auth's JWT expiry must stay at 3,600 s.
- **Diagnostics:** `curl -X POST http://127.0.0.1:54430/api/admin/v1/diagnostics -H "authorization: Bearer $HFOS_SYNC_ADMIN_TOKEN" -d '{}'` (the token `sync:start` gave the service; it reads `HFOS_SYNC_ADMIN_TOKEN` and falls back to a local-only default) shows the slot, lag, `wal_status` and any stream errors.
- **The tests:**
  - `packages/db/test/sync-secrets.test.ts` checks the publication, the role's grants and this config on every DB run.
  - `sync-streams.test.ts` runs every query here in Postgres for an owner, a member, an agency admin and a stranger. It fails if a phone would get a row or column RLS and the grants wouldn't let that person read. Add a row to its fixture when a stream reads a new table.
  - `packages/db/test/sync-access.test.ts` and `sync-window.test.ts` hold the stored rules to RLS.
  - `sync-limits.test.ts` needs the running service: `HFOS_SYNC_TESTS=1 pnpm --filter @hfos/db exec vitest run test/sync-limits.test.ts`.
  - `packages/core/test/mobile-contract.test.ts` records every stream's tables, columns and types (`src/shape.ts`), and fails when a column an old app build reads is removed, renamed or retyped, or a stream name has no version.
  - The sync scenarios (`test/scenarios`) need the running service too: `pnpm --filter @hfos/sync test:scenarios`. Their phones keep a real SQLite copy and an outbox, and follow the plan's upload rules (`test/harness/phone.ts`). `HFOS_SYNC_TRACE=1` prints what each phone's uploader does; `HFOS_SYNC_TRACE=sdk` adds PowerSync's own log.
  - CI: `.github/workflows/sync.yml` starts the stack and this service and runs the scenarios and the limits, on `main` and nightly.

## How the streams are cut

| Stream        | Subscribed                                                       | Buckets per person                                                                                                                                                               | Parameter results |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `me_v1`       | automatically                                                    | 1                                                                                                                                                                                | 0                 |
| `business_v1` | by the app, once per business kept offline: `{workspace_id}`     | 1 per business for each of its five lookups that matches them: 4 for a member, 5 for an owner or admin                                                                           | the same          |
| `agency_v1`   | automatically                                                    | 1 per agency they belong to                                                                                                                                                      | 1 per agency      |
| `records_v1`  | by the app, beside `business_v1`, with the same `{workspace_id}` | 1 per business for each of its lookups that matches them: `access` (their own check-ins), `addon_use`, and `addon_all` and `team_of` for someone who sees every record of a kind | the same          |

- **One bucket per business for most of its tables.** Most `business_v1` queries filter on the same lookup, `access`: the person's own `workspace_access` row for the subscribed business. That lookup returns at most one row per subscription. A business the person can't open gives no bucket, and a made-up id costs nothing. `workspace_access` is kept equal to `private.effective_workspace_role()` by triggers (migration 0056).
- **Money.** The money of whoever manages it (owners and admins unless the business says otherwise, 0106) uses a second lookup in the same stream (`manages_money = true`, kept on `workspace_access` by triggers), so it gets its own bucket per business. Anyone else who may see money — a member, or someone the business lets bill — has theirs in their own `me_v1` bucket, filtered on each document's trigger-kept `member_viewer_ids`. That is one bucket however many documents they may see, and it covers every business where they are one. Plans stay with the managers' copy: someone who bills without managing money starts and runs them on the web.
- **The inbox.** The same two-sided shape, one milestone later (0083). `business_v1`'s four inbox tables (and the AI teammate's drafts, which follow their thread) use a third lookup, `inbox` (`sees_whole_inbox = true`), which is every business for everybody until a business says each person sees their own threads — and owners and admins always. A narrowed member's threads come through their own `me_v1` bucket, filtered on each thread's trigger-kept `member_viewer_ids`, exactly as their money does. **One more bucket per business at most:** the lookup gives at most one row, and the me_v1 arm rides the bucket that is already there.
  - The column lists in the two arms are identical, and `packages/db/test/sync-inbox-config.test.ts` holds them that way without needing a database; `private.sync_inbox_mismatches()` holds the stored lists to the policies with one.
- **What a business can take away** (20261012060300). The catalogue (products and plans) needs `money.read`, and the AI teammate's drafts need `inbox.use`, both of which a business can take from someone. `business_v1` reads each off the same `workspace_access` row as a lookup of its own, `reads_money` and `inbox_drafts` (the `inbox` lookup narrowed by `uses_inbox`), so each is one more bucket per business for the people it matches.
- **Recent history only.** `sync_window` is a stored flag, because streams can't compare dates. The worker's nightly `private.sync_window_sweep` turns it off; triggers turn it back on at once.
- **Measured** against the local service (`sync-limits.test.ts`), with both limits at 1,000:
  - An agency owner keeping 12 businesses offline: **62 buckets, 61 parameter results**, 13,220 operations in under a second.
  - A member who may see 2,000 documents: **5 buckets, 4 parameter results**; their own bucket holds 4,003 operations.
  - An agency owner reaches the limits at about **199 businesses kept offline at once**: (1,000 − 1) ÷ 5.
- **Every change to `sync-config.yaml`, even a comment, makes PowerSync copy everything again.** Batch changes.
  - A change to what a stream sends is a new stream version (`business_v2`) beside the old one, so phones on old builds keep working.
  - A published table may only grow compatible columns.
  - Adding a column with a default to a published table doesn't reach PowerSync for existing rows until each row is written again (or everything is copied again).

## Table by table

Every query names its columns. Columns not listed never leave for a phone, even though a published table's every column reaches PowerSync's own storage. Nothing secret is on a published table (migration 0057's audit).

### `me_v1` — the person's own

| Table (client table)                                                              | What syncs                                                      | Filter and window                                          | Left out                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| `workspace_access`                                                                | Their role in each business they can open, and what they may do | `user_id` is theirs. Synthesized id `user_id:workspace_id` |                           |
| `users` (as `my_profile`)                                                         | Their profile and settings (theme; email and push switches)     | Their own row                                              | Membership lists          |
| `command_receipts`                                                                | What became of each command their phone sent (outcome, answer)  | Theirs; the server keeps 90 days                           | `input_hash`              |
| `push_devices`                                                                    | Their devices: platform, version, name, last seen, turned off   | Theirs                                                     | `expo_push_token`         |
| `user_phones`                                                                     | Their cells and verification state                              | Theirs                                                     |                           |
| `estimates`, `estimate_lines`, `invoices`, `invoice_lines`, `payments`, `refunds` | Money of the jobs they're on (member rule of 0050)              | `auth.user_id() IN member_viewer_ids AND sync_window`      | See the money table below |

### `business_v1` — one business kept offline

| Table (client table)                                                              | What syncs                                                                    | Filter and window                                                | Left out                                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `workspaces`                                                                      | The business and its settings (open hours, quiet hours, money, Action Center) | The business                                                     |                                                                                                          |
| `workspace_memberships`                                                           | Its team and their roles (direct members, whom everyone in it may see)        | All                                                              |                                                                                                          |
| `users`                                                                           | Team names: id, email, name, avatar                                           | Direct members, via `users.member_workspace_ids`                 | Settings, membership lists                                                                               |
| `pipelines`, `pipeline_stages`, `tags`                                            | All                                                                           | All                                                              |                                                                                                          |
| `record_tags`                                                                     | All; synthesized id `tag_id:record_type:record_id`                            | All                                                              |                                                                                                          |
| `people`                                                                          | Every customer, with `field_times` and `possible_duplicate_of`                | All, archived included                                           | `search_text` (generated), import columns                                                                |
| `companies`                                                                       | Every company                                                                 | All                                                              | `search_text` (generated), import columns                                                                |
| `leads`                                                                           | Every lead, with qualification and contact times                              | All                                                              | `search_text` (generated)                                                                                |
| `tasks`                                                                           | Tasks still to do, and done ones                                              | `sync_window`: open, or done in the last 90 days                 |                                                                                                          |
| `activities`                                                                      | The timeline                                                                  | `sync_window`: 12 months                                         | `event_id`                                                                                               |
| `files`                                                                           | File details (the file itself downloads when opened)                          | Not deleted, not knowledge-base files                            |                                                                                                          |
| `conversations`                                                                   | Every conversation                                                            | `inbox`; narrowed: the person's own (0083)                       | `email_reply_token`, AI bookkeeping (`ai_epoch`, `ai_answered_through`)                                  |
| `messages`                                                                        | Texts (with RCS's buttons, cards and read times), emails and chats            | `inbox`; `sync_window`: 12 months, all of an open one            | `body_html`, provider ids and headers, mailbox, AI run and draft ids                                     |
| `calls`                                                                           | The call log, voicemail flag and transcript                                   | `inbox`; `sync_window`: as messages                              | Provider and recording ids, the recording's path                                                         |
| `opt_outs`                                                                        | Who said stop                                                                 | All                                                              |                                                                                                          |
| `email_suppressions`                                                              | Addresses that bounced or complained                                          | Not released                                                     | Provider reference, origin                                                                               |
| `phone_numbers`                                                                   | The business numbers                                                          | Not released                                                     | Routing (forwarding cells), provider ids, errors                                                         |
| `email_addresses`                                                                 | Sending addresses                                                             | All                                                              |                                                                                                          |
| `attention_items`                                                                 | Home's items, with everything core's score uses                               | `inbox`; not resolved                                            | Fingerprints, alert and resolution bookkeeping                                                           |
| `ai_teammates`                                                                    | The teammate's name and status (for "Ava (AI)")                               | All                                                              | Its settings and training counts                                                                         |
| `ai_teammate_drafts`                                                              | Drafts waiting for an OK                                                      | `inbox_drafts` (0083 + 0106); pending (narrowed: their threads') | Decision columns                                                                                         |
| `workflow_approvals`                                                              | Approvals waiting (the preview carries the workflow's name and the customer)  | Pending                                                          | Decision columns                                                                                         |
| `calendars`                                                                       | Calendars and their settings                                                  | All                                                              |                                                                                                          |
| `calendar_members`, `calendar_services`, `service_staff`                          | Who is on each calendar, its services, who does each; synthesized ids         | All                                                              |                                                                                                          |
| `calendar_busy_blocks`                                                            | People's busy times                                                           | All (the worker keeps only the coming weeks)                     | `connection_id`                                                                                          |
| `services`, `schedules`, `schedule_exceptions`                                    | All                                                                           | All                                                              |                                                                                                          |
| `appointments`                                                                    | Visits, sessions and events                                                   | `sync_window`: ended no more than 90 days ago                    |                                                                                                          |
| `appointment_attendees`                                                           | Who comes, their contact details, intake and confirmation                     | `sync_window`: their appointment's                               | `public_ref`, `manage_version`, `reminder_state`                                                         |
| `appointment_staff`                                                               | Who works it; synthesized id `appointment_id:user_id`                         | `sync_window`: their appointment's                               | `during`, `blocked` (the appointment has the times)                                                      |
| `products`, `plans`                                                               | The catalogue, archived included                                              | `reads_money` (0106); all                                        |                                                                                                          |
| `estimates`, `estimate_lines`, `invoices`, `invoice_lines`, `payments`, `refunds` | Owners' and admins' money                                                     | Managers only; `sync_window`: open always, closed for 12 months  | See the money table below                                                                                |
| `subscriptions`                                                                   | Maintenance plans                                                             | Managers only; all                                               | `public_ref`, `pay_version`, `connection_id`, `external_subscription_id`, `customer_ref`, `method_token` |

Private records (Real Estate step 4) never reach a phone through `business_v1`, and neither does anything hanging off
one: its tasks, activities, files and attention items, and `me_v1`'s attention items, send only `sealed = false`
rows. Files also send `locked_at` (a signed file is kept). Add-ons' Home cards (`kind = 'addon_alert'`, step 5) stay
out of `business_v1` too. Since round six they reach phones through `records_v1`, below.

### `records_v1` — an add-on's records, and everything sealed to them (Real Estate round six)

A private record (a deal) and what hangs off it go only to the people allowed to see it: its owner and team, and
someone who sees every record of its kind (a broker) gets the summary rows (`reach = 'all'`). Nothing per person is
written on the rows themselves; they carry **seals** that triggers keep, and each person holds **keys**:

- **Keys** (`app.sync_keys`, kept by a trigger on `workspace_access.permissions`): `use` = `<business>:<the add-on's
phone permission>`, held while the person has it and the add-on runs there; `all` = `<business>:<the kind's
see-every permission>`. Turning the add-on off takes its permissions away, so the keys go and its rows leave phones
  with nothing deleted.
- **Seals** on `custom_records`, `custom_record_types`, `tasks`, `activities`, `files`, `appointments`,
  `appointment_attendees`, `conversations` (portal threads), `messages` and `attention_items`: `seal_scope` (the key
  that opens it), `seal_viewer_ids` (the record's owner and team; a thread narrowed by the inbox's setting further),
  `seal_open` (no team: anyone with the key) and `seal_all` (the see-every key, on summary rows only).
- **An add-on's own rows** go as JSON in `app.addon_phone_rows`, copied by triggers that
  `private.addon_phone_table(table, record column, columns, reach)` installs from the add-on's migration: only the
  columns it names (never one that looks like a secret), with its record's seals. Changing what a phone keeps of an
  add-on is a migration, never a change here.
- **Windows**: a record leaves phones when its add-on narrows `sync_window` (`private.record_phone_window`; Real
  Estate keeps open deals and those ended in the last 90 days).
- **Links** (`relationships`, and `relationship_types` with the add-on's key; 20261022000700): a deal's client, its
  home, its lender. A link to one record takes that record's seals; a link between two goes to who may see both
  (open when both are, the people on both when both are private); a link to a kind phones don't keep, or between two
  add-ons' records, reaches no phone. A record's seals or window moving moves its links.
- **The team** (core; 20261022001200), behind the `team_of` lookup: to whoever sees every record of an add-on's kind,
  who holds the add-on here and as what (each `use` key, as `team_keys`), for Team workload. Nothing else about
  anyone's permissions.
- **The person's own check-ins and safety contacts** (core; 20261022001000), behind the `access` lookup: theirs
  alone, in a business they can open, so a check-in's banner, +15 min and check-out work with no signal. A contact's
  link (`safety_escalations`) never reaches a phone.
- **Settings** an add-on names (`offline.settings`; 20261022000800): those keys of its business settings, as one
  `addon_phone_rows` row per business (source `_settings`, no record), open to its key. Real Estate keeps its closed
  days, for Coordinate's business days.

`private.sync_key_mismatches(business)`, `private.sync_seal_mismatches(business)` and
`private.addon_phone_mismatches(business)` say where stored keys or seals disagree with the permissions and records;
`packages/db/test/phone-records.test.ts` and `sync-streams.test.ts` hold them empty.

### `agency_v1` — the agencies a person belongs to

| Table (client table)       | What syncs                                  | Filter                              |
| -------------------------- | ------------------------------------------- | ----------------------------------- |
| `organizations`            | The agency's name                           | The person belongs to it            |
| `organization_memberships` | Its people and their roles                  | Same                                |
| `users`                    | Their names (same columns as `business_v1`) | Via `users.member_organization_ids` |

### Money, wherever it syncs

| Table       | Left out                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `estimates` | `public_ref`, `link_version`, `accepted_wording`, `accepted_hash`, bookkeeping                            |
| `invoices`  | `public_ref`, `link_version`, `connection_id`, `reminder_state`, `balance_cents` (generated), bookkeeping |
| lines       | Bookkeeping only                                                                                          |
| `payments`  | `connection_id`, `provider_payment_id`, `provider_status`, `idempotency_key`, bookkeeping                 |
| `refunds`   | `connection_id`, `provider_refund_id`, `provider_status`, `idempotency_key`, bookkeeping                  |

"Bookkeeping" is `sync_window` and `member_viewer_ids`: they decide what syncs and are never sent.

## What the phone works out itself

- **Search text** for customers, companies and leads (`search_text` is generated, and Postgres 17 doesn't replicate generated columns). It uses the same lower-cased join the migrations use:
  - People: first name, last name, email, `phone_e164` (not the display `phone`), city, first address line.
  - Companies: name, email, `phone_e164`, city, first address line.
  - Leads: the title.
- **An invoice's balance**: core's `balanceCents(total, paid, refunded)` — what's still owed is total less paid, and a refund only uses up an overpayment.
- **Display states** of money: "Refunded", "Partly refunded", "Opened", "Paying". They come from the amounts and stamps, as on the web.
- **Whether a plan has a card:** card brand and last four are there. The provider's card token is not.
- **Home's order:** core's attention score over the synced items (value, probability, confidence, since, urgent from, due, reasons). Detectors stay on the server.
- **Who someone is:**
  - Names come from `users`: direct members for everyone, agency people for agency staff.
  - An id with no row is someone the person may not see, or a "Former teammate".
- **Availability and booking:** these need the server. Booking offline asks for a time, shown as "Not booked yet".
- **Online only:** an email's HTML, a call recording, a file's contents and customer links (they need a signed HMAC) are fetched when opened.
