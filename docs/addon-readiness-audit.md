# Add-on readiness audit

HandsFreeOS is about to grow a large number of optional add-ons: ten, twenty or more switched on in one
business, a different mix in every business, from simple screens to add-ons with their own tables, jobs,
integrations and AI tools. This is the audit of whether the platform is ready for that, written on
2026-09-27 before any add-on exists. Eight reviewers covered it at once: the kernel and events, the
database, permissions and billing, the AI, the web and phone apps, workflows and integrations, and testing.
The eighth worked out what the ideal add-on system for this stack would look like, so the other seven had
something to measure against.

**Verdict.** The core is in good shape for add-ons: one command pipeline for every change, tenancy enforced
by the database, a permission list the database works out and every layer reads, a transactional outbox,
and a generic record-and-relationship layer. **What is missing is the add-on layer itself.** Nothing
anywhere knows that a business has or hasn't got a feature. Every catalogue (commands, event handlers, job
kinds, AI tools, workflow steps, menu places) is a closed list in core. Work done by the system, workflows
and the AI teammate skips permission checks by design, so it would keep running for a turned-off add-on.
None of this needs a redesign; it needs one new layer and a handful of seams in code that already exists.

Findings are marked **Critical** (fix before any add-on is built), **Important** (part of the foundation)
or **Improvement** (useful, not needed yet). Ids point at the reviewer's area: K kernel and events, DB
database, P permissions, settings and billing, AI, FE web and phone, WF workflows and integrations, T
testing.

**Where this stands (2026-09-28).** The foundation is built; `docs/addon-architecture.md` describes it.
Every Critical finding is fixed except the workflow half of WF-2 (add-on workflow steps and triggers, which
wait for the first add-on). Fixed: the add-on and capability model (K-1, DB-1, P-1, WF-1, AI-1); the
add-on check for machine actors (P-1, K-1); registration for operations, event handlers, jobs, Assistant
tools and menu places (K-2, K-4, FE-2); isolated event delivery (K-3, WF-4); owners on queued work (K-5,
WF-9); WF-3; managed record kinds (DB-2, DB-3); P-2; P-3; FE-1 and FE-4; AI-2; AI-3. Of the Important
ones, P-4, K-9, K-10 and DB-13, DB-5 and T-5 (for add-on tables), FE-3, FE-5 and AI-6 are done too; the
rest are open, and the architecture doc's "Not yet" lists what the first add-on will need.

## 1. The current architecture

- **One write path.** Every change is a command (`packages/core/src/commands`, 496 of them, 389 reachable
  by people) run by the kernel (`packages/core/src/kernel/execute.ts`): validate, resolve the business in
  one SQL statement, check the permission, run the handler, then write the event, outbox and audit rows in
  the same transaction. Reads are queries (156). `apps/api/src/routes.ts` mounts one route per registry
  entry, so the API has 385 lines of its own.
- **Tenancy in the database.** App tables live in schema `app` with row-level security (802 policies). The
  API switches to `authenticated` with the person's token; the worker switches to `service_actor` bound to
  one business per job.
- **Permissions worked out once.** Role defaults, the business's settings for a role and for a person are
  combined by `private.user_permissions()` into `app.workspace_access.permissions`
  (`20261006000600_permissions_a_business_sets.sql`). Row security, the kernel, the screens, the phone and
  the Assistant all read that one stored answer.
- **Side effects through the outbox.** The worker claims outbox rows and runs every handler for the event,
  in order, in one transaction (`apps/worker/src/outbox.ts:92-118`). Scheduled work is `app.scheduled_jobs`
  (110 job kinds in `apps/worker/src/scheduled.ts`); provider webhooks are stored, then processed.
- **Generic records.** Custom record kinds and many-to-many relationships
  (`20261005000200_relationships.sql`, `docs/relationships.md`) already give a business's own records a
  timeline, tasks, appointments, files, fields, search and a page.
- **AI through the same pipeline.** The Assistant has 161 hand-written tools
  (`packages/core/src/assistant/tools*.ts`) whose executors run commands as the person
  (`apps/worker/src/assistant/tools-read.ts:49-88`). All but about 20 are deferred behind Claude's tool
  search. The AI teammate has 40 tools, runs as its own actor, and is held to an allowlist of 30 commands
  (`packages/core/src/kernel/actor.ts:39-74`).
- **Apps.** Next.js app router (81 workspace pages, split per route), an Expo phone app on PowerSync, one
  Realtime channel per business broadcasting event ids only.

## 2. What is already suitable for add-ons

- **The command pipeline is the action layer.** The UI, workflows, the Assistant, the AI teammate and the
  worker already reuse the same business logic, permission check and audit trail. Add-on actions only have
  to be commands.
- **The stored permission list is the right off-switch.** If an add-on's permissions are only worked out
  while it is on, row security, the kernel, the screens, the phone and the Assistant all turn it off for
  people at once, at no cost per row.
- **Custom records are the right anchor for add-on things.** A Property, Lease, Vehicle or Project made as
  a custom record of an add-on-owned kind inherits the timeline, tasks, files, appointments, relationships,
  fields and search, with no change to those tables.
- **`resolveScope` is one SQL statement**, so knowing which add-ons are on rides along at no extra round
  trip.
- **The workspace deletion job** (`apps/worker/src/workspace/delete.ts`) and its "nothing left behind" test
  (`packages/db/test/workspace-delete.test.ts`) are ready-made models for uninstalling and purging.
- **Job and webhook idioms fit:** dedupe keys, a `cancelled` status, leases, store-then-process webhooks,
  sealed credentials with key rotation (`apps/worker/src/crypto.ts`).
- **Deferred AI tools and tool search** are already on, so the tool count can grow without growing the
  prompt.
- **A strong invariant-test culture** (permission parity, OpenAPI freshness, the phone contract, RLS on
  every table) that add-on invariants can copy.

## 3. Problems and risks found

### Critical: fix before any add-on is built

| Id                         | Finding                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| K-1, DB-1, P-1, WF-1, AI-1 | **No add-on or capability model anywhere.** No table, column, kernel field or UI payload says what a business has. The only switches are ad hoc JSON (`settings.automations`, teammate skills), checked at 27 separate call sites.                                                                                           | `kernel/types.ts:200-243`; `20260930000800_usage_wallet.sql:8-11` ("there is no such thing in this repo yet") |
| P-1, K-1                   | **Machine actors skip permission checks by design.** The system, workflows and the AI teammate run as "root within one business". A turned-off add-on's jobs, event handlers, workflow steps and AI tools would keep running.                                                                                                | `kernel/execute.ts:384-400, 470-493`                                                                          |
| K-2, K-4, AI-2, WF-2, FE-2 | **Every catalogue is a closed list in core:** commands and queries (`commands/index.ts:503-827`), event handlers (`handlers/index.ts:111-315`, where a duplicate key silently overwrites), job kinds, Assistant and teammate tools, workflow triggers and actions, menu places. An add-on can only register by editing core. | files cited                                                                                                   |
| K-3, WF-4, T-3             | **One event's handlers share one transaction.** A failing add-on listener rolls back the core handlers, retries all of them, and after 5 tries drops the event, so workflows, the Action Center and push lose it too.                                                                                                        | `apps/worker/src/outbox.ts:92-143` ("a retry runs every one of them again")                                   |
| K-5, WF-9                  | **Queued work has no owner.** `app.scheduled_jobs` and `webhook_deliveries` can't say which feature queued a row, so disabling can't cancel it or prove it's gone.                                                                                                                                                           | `20260913000100_messaging_core.sql:410-429`                                                                   |
| WF-3                       | **One unreadable workflow breaks core events.** The dispatcher parses each matching workflow inside the event's transaction with no catch, so a workflow holding a removed add-on step fails every event of that type for the business.                                                                                      | `apps/worker/src/workflows/dispatch.ts:216`; `packages/core/src/workflows/load.ts:135-141`                    |
| DB-2, DB-3                 | **Timeline, tasks, files and relationships only attach to fixed kinds.** Attaching an add-on entity directly would take core DDL, put foreign keys from core into add-on tables, and collide with the rule that system timeline rows never change (uninstall would fail on the first lease with a system entry).             | `20261005000200_relationships.sql:324-364, 494-525`; `20261002000500:170-185`                                 |
| P-2                        | **Handing out a role uses a TypeScript copy of the rules.** Once a permission depends on an add-on, admins in businesses without it could no longer invite or promote anyone (`cannot_grant_role`).                                                                                                                          | `packages/core/src/commands/role-grant.ts:11-48`                                                              |
| P-3                        | **`workspace.update` merges any settings key.** Add-on state kept in `workspaces.settings` could be switched on by any admin, and the blob goes to every member and phone.                                                                                                                                                   | `commands/workspace.update.ts:29`; `queries/workspace.get.ts:46`                                              |
| FE-1, FE-4                 | **The web app has no error boundaries.** There is no `error.tsx`, `global-error.tsx` or `loading.tsx` anywhere, so one failing panel blanks the whole app. A direct link to a page the person may not open ends in Next's bare error page.                                                                                   | `apps/web/src/app` (none found); `apps/web/src/lib/api/server.ts:24-27`                                       |
| AI-3                       | **Model arguments are spread after the business id** (`{ workspaceId: ctx.workspaceId, ...input }`). Safe today only because no tool declares `workspaceId`; 329 of 389 command inputs do, so tools derived from commands would let the model pick another business the person belongs to.                                   | `apps/worker/src/assistant/tools-read.ts:58, 79`; `assistant/context.ts:286`                                  |
| AI-2                       | **Tool names can't be namespaced.** The ledger's check `^[a-z][a-z_]{0,63}$` refuses digits and dots, and Claude refuses dots.                                                                                                                                                                                               | `20260914000100_assistant.sql:87`                                                                             |

### Important: part of the foundation

| Id             | Finding                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-4            | Any change to the permission defaults recomputes every person in every business, and money and inbox repaints fire on any permission change (0106:326-347). Twenty add-ons would make installs slow and lock-heavy. |
| K-6, WF-5      | One job lane, one retry policy (5 tries over ~75 s), no per-job timeout, no fairness between businesses; provider calls without timeouts can stall every business.                                                  |
| WF-6           | Per-business planners arm jobs for every business whether the feature is on or not, in one transaction; one failing planner stops them all until restart.                                                           |
| K-8            | Event payloads are untyped (483 event types, ~676 string-keyed reads in the worker); add-ons would depend on shapes nobody wrote down.                                                                              |
| K-9            | Work isn't attributed to what did it beyond workflows and the AI; after an add-on goes, its history would read "HandsFreeOS".                                                                                       |
| K-10, DB-13    | Events and audit rows are append-only and keep copies of values; "permanently delete" needs a scoped purge or redaction policy.                                                                                     |
| K-12           | About 22 worker HTTP routes check permissions themselves, outside the kernel; add-on routes need the same add-on check.                                                                                             |
| K-14           | ~340 worker writes bypass commands, some into core tables, and no lint rule keeps add-on code from doing the same.                                                                                                  |
| DB-4           | Destructive paths are hand-listed (`purge_workspace`, `delete_migration`, `anonymize_user`), and foreign keys to people mix cascade, set null, restrict and no action.                                              |
| DB-5, T-5      | New-table RLS is a checklist: the catalog test only checks that RLS is on, not that a worker policy, a workspace foreign key or the tenant-column trigger exist.                                                    |
| DB-6           | `tasks` and `activities` don't check that a person or company belongs to the same business; only core code prevents it.                                                                                             |
| DB-8, T-2      | The Drizzle mirror checks column names only, for 194 of 202 tables.                                                                                                                                                 |
| DB-10          | Which live updates carry ids is a hard-coded SQL list; sensitive add-on records would broadcast ids to every member.                                                                                                |
| P-5, P-6       | No entitlement model; usage keys, `ai_usage.source` and ledger entity types are closed lists or enums; the AI limit is one environment variable for every business.                                                 |
| P-7            | No server-side feature flags (`NEXT_PUBLIC_GMAIL_ENABLED` only hides a button).                                                                                                                                     |
| P-8, WF-8      | Seven bespoke connection tables and a UNION per OAuth lookup; tokens are only revoked at the provider for payments.                                                                                                 |
| P-9, T-11      | The API's "no provider secrets here" guard is a blocklist, copied three times and drifted.                                                                                                                          |
| P-10, FE-11    | Phone sync can't be gated per add-on, and every sync-config edit recopies everything to every phone.                                                                                                                |
| AI-4, AI-5     | Always-loaded tools come from a regex over the prompt text; the 13K-token system prompt hard-codes every place and settings area.                                                                                   |
| AI-6           | No "can now / could with an add-on / planned" model; only prompt text.                                                                                                                                              |
| AI-7           | Confirm cards never expire and commit under a new correlation id with no link to the events they caused.                                                                                                            |
| AI-8, AI-9     | No plan or bulk confirmation for multi-step work; no per-run caps on calls, writes or result size; no rate limit on Assistant messages.                                                                             |
| AI-10          | One shared token limit: heavy Assistant use can stop the customer-facing teammate; no attribution per add-on.                                                                                                       |
| AI-11, AI-12   | Teammate tools, draft actions, reach checks and workflow catalogs are closed; reach refuses custom records outright.                                                                                                |
| FE-3           | The shell has no per-business feature data; `workspace.get` is re-fetched by 63 files.                                                                                                                              |
| FE-5, FE-6     | Core pages have no extension slots, and page loaders are all-or-nothing (`Promise.all` of 14 queries on the person page).                                                                                           |
| FE-7           | The workspace layout statically pulls ~100 modules into every page.                                                                                                                                                 |
| FE-8, FE-9     | Realtime entity types are untyped strings; the settings strip is 20 fixed tabs.                                                                                                                                     |
| WF-7, WF-10–12 | Attention kinds are exhaustive maps in 14 places; workflows have no "add-on off" state; runs can only be about a person, lead, appointment or conversation; there is no shared notification service.                |
| WF-13          | Four settings saves read `workspaces.settings` unlocked and write the whole object back, so two saves can lose one.                                                                                                 |
| T-1, T-4       | Pure tests can't be run on their own; migrations are never checked for edits after they're applied.                                                                                                                 |

### Improvement: useful later

K-7 (four closed action catalogs — partly covered by the foundation), K-11 (rate limits beyond two commands),
K-13 (add-on fields in logs, per-add-on failure views), K-15 (behaviour chosen by name prefix), K-16–K-18,
DB-11 (a cross-entity index), DB-12 (enums as extension points), DB-14 (system-scope setting trusted from any
role), DB-15 (batched purge, global FK-index lint), P-11 (the re-engage "owner reads it first" rule is only in
the web), P-12 (workflow publish doesn't check actions against the publisher), P-13–P-15, AI-13–AI-18, FE-10,
FE-12–FE-17, WF-14–WF-18, T-6–T-14.

## 4. What needs to change before add-ons are built

1. An add-on catalogue in code and a per-business installation row, with lifecycle states.
2. One add-on check in the kernel, for every kind of actor and every entry point.
3. Add-on permissions that only exist for people while the add-on is on (fold into
   `private.user_permissions()`), with role hand-outs computed from the same rules.
4. Registration seams: add-on commands and queries, event subscribers, job kinds and AI tools join the
   registries through one explicit list per layer.
5. Isolated event delivery for add-ons, and an owner (`addon_id`) on queued jobs and webhook deliveries so
   disabling cancels them in one statement and a job re-checks before it runs.
6. Add-on-managed custom record kinds as the anchor for add-on entities, so core never references add-on
   tables.
7. Lifecycle commands (install, enable, disable, uninstall, purge) with dependency checks, an impact report
   and a verification that nothing is left running.
8. AI tools declared by add-ons, offered only while the add-on is on, always deferred, re-checked at
   execution; a capability-discovery tool that separates "can now", "could with an add-on" and "planned".
9. Error boundaries in the web app, an add-on route gate, add-on menu places and extension slots.
10. Tests that run over every manifest, and a fixture set of 12+ add-ons for the lifecycle and isolation
    suites.

## 5. Proposed add-on architecture

**Register statically, activate per business, enforce in one place.** Add-ons are first-party code that
ships with every deploy, listed explicitly. Whether a business has one on is a row in
`app.addon_installations`. Every entry point — the kernel, row security (through permissions), jobs, event
delivery, AI tools, menus and routes — asks that row. Runtime plugin loading, per-business code versions and
per-business route mounting are deliberately not part of this.

**Where an add-on lives.** Beside every existing feature, layer by layer, so the web part can use the UI kit
and the worker part the worker's services:

| Part                                                    | Where                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Manifest (browser-safe): what it is, provides and needs | `packages/core/src/addons/<id>/manifest.ts`                                       |
| Commands, queries, AI operations                        | `packages/core/src/addons/<id>/`                                                  |
| Event subscribers, jobs, lifecycle hooks                | `apps/worker/src/addons/<id>/`                                                    |
| Pages, panels, settings                                 | `apps/web/src/addons/<id>/`, with pages under `app/w/[workspaceId]/a/<id>/`       |
| Tables                                                  | its own schema `addon_<id>`, in `supabase/migrations/<ts>_addon_<id>_<slug>.sql`  |
| Registration                                            | one line each in `packages/core/src/addons/index.ts` and the worker and web lists |

`pnpm addon:new <id>` scaffolds all of it from a template.

**The manifest** declares, in one browser-safe object: id, name, version, data and settings versions,
description, category, catalogue status, capabilities, permissions (with default roles), dependencies
(required or optional), the record kinds and relationship types it manages, commands, queries and their AI
exposure, events it emits and consumes, jobs, external resources it creates, menu places, routes, extension
panels, settings schema and flags, meters and limits (never prices), data ownership and what happens to its
records on purge. Tests validate every manifest.

**Commands stay the one action layer.** An add-on's commands are ordinary commands made with
`defineAddonCommand(manifest, …)`, which stamps the owning add-on on them. The UI, workflows, the Assistant,
the AI teammate and other add-ons all call them through the kernel.

**Add-ons work together through three channels only**, so there is never an A→B adapter:

1. **Shared records.** Add-on things are anchored as custom records, so any add-on and core can link to
   them through relationships, tasks, files and the timeline.
2. **Actions by name** through the kernel, allowed only between add-ons that declare the dependency.
3. **Events.** An add-on subscribes to core or other add-ons' events; delivery is isolated per subscriber.

## 6. Capability architecture

- **A capability** is a coarse feature, `<domain>.<feature>` (`social.publish`, `crm.contacts`), provided
  by core or by one add-on, optionally tied to a permission. Permissions stay the unit of per-person access.
- **`can()`** means: provided by core or by an add-on that is on in this business, and the person holds its
  permission. The kernel asks it on the server for every actor; screens read the same answer from
  `account.me` and `workspace.get` (`addons`, `capabilities`).
- **Three sets, worked out in code, not in the prompt:** what this business _can do now_; what it _could do_
  with an add-on that is available but not installed; and what is _planned_ (never recommended or offered).
  Plus "installed but you don't have permission" and "turned off" for honest answers.
- **Catalogue status** lives in the manifest (planned, development, beta, built, available, deprecated,
  unavailable), with a staff-controlled override in the database as an emergency off-switch.

| Status      | Code exists | Businesses can install | Recommended        | Runs if installed |
| ----------- | ----------- | ---------------------- | ------------------ | ----------------- |
| planned     | no          | no                     | never              | –                 |
| development | yes         | staff grant only       | never              | yes               |
| beta        | yes         | staff grant only       | never              | yes               |
| built       | yes         | staff grant only       | never              | yes               |
| available   | yes         | yes                    | only when relevant | yes               |
| deprecated  | yes         | no                     | never              | yes               |
| unavailable | yes         | no                     | never              | **no**            |

- **Cost:** the add-ons that are on come from a primary-key lookup in the same transaction; permissions are
  already stored per person. No application cache, so nothing to invalidate.

## 7. Cross-add-on data architecture

- **Ownership tiers.** Core tables (`app.*`) are never deleted by an add-on. Add-on tables live in the
  add-on's own schema (`addon_<id>.*`), so what an add-on owns is mechanical to list, check and purge.
  Things an add-on creates through core commands (tasks, notes, messages, invoices, files) are core records
  with the add-on recorded as their origin, and are never purged with it.
- **Anchored entities.** A Property, Lease or Project is a custom record of a kind the add-on manages, plus
  a typed row in `addon_<id>` keyed to it one to one. Core features (timeline, tasks, appointments, files,
  relationships, fields, search, the record page, the Assistant's record tools) work on it unchanged.
- **Links.** Inside an add-on: typed foreign keys. From an add-on to core: foreign keys with `set null` or
  `cascade` only. Many-to-many across core and add-ons (Tenant↔Lease, Contact↔Vehicle, Task↔Project):
  relationship types the add-on manages, with real foreign keys on both ends and cardinality enforced by
  the database. **Core never holds a foreign key into an add-on schema.**
- **No universal entity table and no universal search index for now.** Anchored records are already
  searchable through the custom-record search; a federated search can come later if it's needed.

## 8. AI, Assistant and AI teammate integration

- **Tools come from the action layer.** An add-on command or query declares `ai` metadata (tool name
  `<addon>_<verb>_<noun>`, description, autonomy); a generic executor runs it through the kernel as the
  person. No per-tool glue.
- **Offered only when relevant.** A request's tools are core's (as today) plus the tools of add-ons that
  are **on** and whose permissions the person holds. Add-on tools are always deferred behind tool search,
  so they cost nothing until the model looks for them and never break the prompt cache. A one-line
  directory per active add-on tells the model what exists.
- **Discovery is architectural.** A read-only `find_capabilities` tool returns the three sets. Tools of add-ons
  that aren't installed are never sent, so the model cannot call them; planned add-ons are never returned as
  installable.
- **Enforced outside the model.** A tool call is refused unless it was offered, its add-on is still on, and
  the kernel's permission and add-on checks pass; confirm cards re-check at commit. The business id is always
  injected after the model's arguments. Risk sets the minimum autonomy (look-ups run on their own; anything
  that reaches customers, moves money or deletes asks), and add-ons may only make it stricter.
- **The AI teammate** gets an add-on's customer-facing tools only when the add-on is on and the business
  switches the skill on; its command allowlist grows by the add-on's declared teammate commands.
- **Recommendations** (later): only when nothing the business has can do what was asked, only for
  `available` add-ons that match, at most once per conversation, and only to people who can install.

## 9. Add-on lifecycle and removal

```
(not installed) ──install──▶ installing ──job──▶ enabled ◀──enable── disabled
                                                    │ ──disable──────────▶ │
                              enabled or disabled ──uninstall──▶ uninstalling ──job──▶ uninstalled
                                          uninstalled ──install (reinstall)──▶ installing
                                          uninstalled ──purge──▶ purging ──job──▶ purged
```

- **Disable** stops the add-on at once: its permissions leave everyone's list (row security and screens
  follow), the kernel refuses its commands and queries for every actor, pending jobs and deliveries are
  cancelled, its record kinds are hidden, its AI tools and menu places disappear. Data, settings and
  relationships stay.
- **Uninstall** also releases what it holds outside HandsFreeOS (provider webhooks, tokens), ends its
  billing, and verifies nothing is left running. History and data stay unless purged.
- **Purge** (permanently delete) is its own action: only from uninstalled, after an impact report, a typed
  confirmation and the right permission. It deletes the add-on's schema rows and the links it owns, and keeps
  anchored records as named tombstones so tasks, files and timeline lines still read "Property: 12 Main St
  (removed with Property Management)". Core records are never deleted.
- **Reinstall** bumps a generation number (so stale queued work is inert), runs the add-on's data and
  settings migrations from the version it was at, and applies renamed capabilities and new permissions.
- **Every transition ends with a verification** (`private.addon_verify`): no permissions, pending jobs,
  deliveries, open external resources or visible record kinds left where there shouldn't be. A failing
  check keeps the add-on in its transitional state with the findings, and is never reported as done.

## 10. Dependency management

Manifests declare `requires` (required or optional add-ons). Tests reject cycles, unknown targets and
imports that don't match a declaration. At runtime an impact report lists what depends on an add-on
(required by, uses data from, shares relationships with, listens to events from), and the lifecycle
commands refuse to break a required dependency unless the caller chose to include the dependents, which is
what lets the app ask one simple question.

## 11. Data ownership and retention

| On…       | Add-on tables | Anchored records | Links it owns | Core records | Settings | History lines |
| --------- | ------------- | ---------------- | ------------- | ------------ | -------- | ------------- |
| disable   | kept          | hidden           | hidden        | untouched    | kept     | kept          |
| uninstall | kept          | hidden           | hidden        | untouched    | kept     | kept          |
| reinstall | migrated      | shown again      | shown again   | untouched    | migrated | kept          |
| purge     | deleted       | tombstoned       | deleted       | untouched    | deleted  | see decision  |

The kernel stamps `_addon` on every event an add-on causes, and timeline entries keep the add-on's name,
so history stays readable after the code is gone.

## 12. Database changes

- `app.addon_installations` (state, versions, generation, settings, flags, last error, who and when), with
  RLS and a guard that only lifecycle functions change state; `app.addon_user_settings`;
  `platform.addon_overrides` (staff off-switch).
- `addon_id` on `app.role_permissions` and `app.customizable_permissions`; `private.user_permissions()` drops
  an add-on's permissions unless it is on; a trigger refreshes only that business's people when its state
  changes.
- `addon_id` and `addon_generation` on `app.scheduled_jobs` (with a partial index on pending rows) and
  `addon_id` on `app.webhook_deliveries`; `addon_id` on `app.events` for attribution.
- `addon_id` on `app.custom_record_types` and `app.relationship_types` (managed kinds: exempt from the
  30-kind limit, structure locked, changed only by their add-on); tombstone columns on `app.custom_records`.
- `app.addon_resources`: what an add-on holds outside HandsFreeOS, released on uninstall and verified.
- `app.addon_usage_events`: idempotent usage metering, refused while the add-on is off.
- Helpers: `private.active_addons()`, `private.addon_table_policies()` (a new add-on table's RLS, triggers
  and grants in one call), `private.addon_verify()`, the purge function and its bypass marker.
- Catalog tests extended to every `addon_*` schema; widened tool-name check on the Assistant ledgers.

## 13. Security changes

- The kernel's add-on check for people, the system, workflows and the AI teammate, in `executeCommand`,
  `executeCommandIn`, `executeCommandWithin` and `executeQuery`, with a row lock so a disable waits for
  in-flight add-on commands.
- Add-on permissions materialized only while on (row security follows automatically).
- Role hand-outs computed with the add-ons that are on (P-2).
- `settings.addons` refused by `workspace.update` (P-3).
- Business id injected after model arguments in every Assistant executor (AI-3).
- A lint and a test that keep add-on code from writing core tables directly or importing another add-on
  it doesn't declare.
- New add-on tables can't ship without the standard policies (catalog lint).

## 14. Performance changes

- Add-on state rides the existing scope query for people; machine actors look it up only for add-on
  operations; core operations pay nothing.
- Add-on subscribers are fanned out only for businesses where they're on; disabled add-ons get no job rows.
- Add-on AI tools are deferred; the loaded tool set and the cached prompt prefix don't grow with add-ons.
- Add-on pages are route-split; panels load lazily inside boundaries; nothing loads for an add-on that's off.
- Pure time-budget tests for capability resolution and tool selection with 30 add-ons.

## 15. Files and modules affected

Core: `kernel/{types,define,registry,execute}.ts`, `server.ts`, `permissions.ts`, new `addons/`,
`commands/{role-grant,workspace.update}.ts`, `schemas/workspace.ts`, `queries/{me,workspace.get}.ts`,
`account/menu.ts`. Worker: `outbox.ts`, `jobs.ts`, `deliveries.ts`, `scheduled.ts`, `handlers/index.ts`,
`workflows/dispatch.ts`, `assistant/{runtime,context,tools-read,tools-calendar,routes}.ts`, new `addons/`.
Web: `app/global-error.tsx`, `app/app/w/[workspaceId]/{error,not-found}.tsx`, `lib/api/server.ts`,
`components/shell/*`, new `addons/` and `components/addons/`. Database: new migrations, the Drizzle mirror,
`packages/db/test`. Scripts: `scripts/addon-new.mjs`. Docs: `docs/addon-architecture.md`, README.

## 16. Decisions made by the owner (2026-09-28)

| Question                                                             | Decision                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Turning off or uninstalling an add-on another installed one needs    | **Offer to turn off both.** Show what depends on it and what would stop working, then ask. Nothing is removed silently.                    |
| How long an uninstalled add-on's data is kept                        | **Until an owner deletes it.** Hidden but kept, so reinstalling brings it back; permanent deletion is a separate, confirmed action.        |
| Whether permanent deletion removes the history lines an add-on wrote | **Keep the lines, drop the details.** Who, when, what happened and the record's name stay; the add-on's detailed data goes.                |
| What happens to things an add-on scheduled when it's turned off      | **They stop, and nothing goes out late.** Anything that came due while it was off waits for a person to reschedule it.                     |
| Who may install, turn off and uninstall add-ons                      | **Owners and admins** (a business can change it per role or person). **Only owners** may permanently delete an add-on's data.              |
| How much the AI may do on its own across several add-ons             | **Ask only for sensitive steps.** Look-ups, notes and tasks run on their own; messaging customers, moving money, deleting or settings ask. |
| Workflows using a step from an add-on that's turned off              | **Hold and tell the owner.** Customers wait at that step and carry on when it's back on; uninstalling pauses those workflows.              |
| Whether people can look at a turned-off add-on's records             | **Hidden until it's back on.** Owners can still download a copy.                                                                           |

A second round, the same day, once the foundation was built:

| Question                                                              | Decision                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What to build next                                                    | **The Add-ons page**, on the web and in the phone app, in its own pull request.                                                                         |
| The first real add-on                                                 | **A Real Estate Agent add-on:** MLS and property data, showings, lockbox details, comparative reports, listing activity and buyer and seller workflows. |
| Add-ons that are planned but not ready                                | **Shown to owners and admins as Coming soon**, clearly marked, with no install button.                                                                  |
| Add-ons in beta                                                       | **Only HandsFreeOS support turns one on** for a business.                                                                                               |
| Support looking at a business                                         | **Sees its add-ons' pages, read-only**, as it sees core's.                                                                                              |
| A kind of record the business renamed, when its add-on is reinstalled | **Keeps the business's name.**                                                                                                                          |
| How paid add-ons are charged                                          | **Per add-on:** a monthly price, usage from the wallet, or both.                                                                                        |
| The customer-facing AI teammate and add-ons                           | **Look-ups, and actions that wait for a person's OK.**                                                                                                  |
| Who may give an add-on the business's own account for another service | **Owners and admins.** Never readable once saved.                                                                                                       |
| HandsFreeOS suggesting an add-on unasked                              | **Occasionally, on Home:** a small card for owners and admins, easy to dismiss.                                                                         |

The rest of billing (per-seat counting, wallet or card, access after a cancel part-way through a month) can wait
until the first paid add-on: the foundation keeps prices out of add-ons and records usage either way.

## Build order

**Phase 1, this foundation (no add-on features):** the catalogue and manifest; installations and lifecycle
commands with dependency checks, impact report and verification; the kernel check for every actor;
permission gating; job, delivery and event-subscriber ownership and isolation; managed record kinds and
tombstones; add-on table helpers and catalog lints; usage metering; AI tool registration, selection,
`find_capabilities` and the AI-3 fix; the workflow dispatcher fix (WF-3); web error boundaries, route gate,
menu places and slots; the template and generator; tests including 12+ fixture add-ons; the architecture
doc.

**Phase 2, with the first add-on:** add-on workflow triggers and a generic command step; Action Center
sources; teammate reach for add-on records; a plan-level confirmation card for multi-step AI work. The
Add-ons page (web and phone, with each add-on's settings) and Home's recommendation card came first, on the
owner's decision, and are built.

**Phase 3, as needed:** a shared integration-connection framework (OAuth, sealed tokens, provider webhook
routes); entitlements and billing through Stripe; phone sync streams and screens per add-on; federated
search; a notification service; job lanes and per-job timeouts.
