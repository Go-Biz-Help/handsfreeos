# Add-ons

An add-on is first-party code that ships with every deploy and that each business turns on for itself: property
management, rent collection, an accounting sync, a social scheduler. It works on core's records (customers,
conversations, payments, files, tasks) rather than beside them, and it can be turned off, uninstalled and have its
data deleted without leaving anything behind. The audit that led here is `docs/addon-readiness-audit.md`.

Three rules shape the design:

1. **Registered in code, switched on per business, enforced in one place.** An add-on's code is always in the
   build. A business's choice lives in `app.addon_installations`. The kernel, the database and the worker refuse an
   add-on's work wherever it isn't on, whatever asked.
2. **Integrated through core, never with each other.** An add-on keeps its things as records of kinds it manages,
   ties them to customers with relationships, and hears what happens through events. It never calls another add-on
   directly and core never points into its tables.
3. **Nothing trusts the screen or the prompt.** Permissions, the add-on check and the AI's tools are all decided
   on the server, from the same answer.

## Where things are

| What                                    | Where                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifests, catalogue, rules (pure)      | `packages/core/src/addons/` (`manifest.ts`, `catalog.ts`, `graph.ts`, `lifecycle.ts`, `capabilities.ts`, `plan.ts`, `recommend.ts`)                           |
| Server half: operations, registry       | `packages/core/src/addons/server.ts`, `modules.ts`, `load.ts`; the kernel's check in `kernel/execute.ts`                                                      |
| Lifecycle commands and queries          | `packages/core/src/commands/addon.ts`, `queries/addon.ts`, `schemas/addon.ts`                                                                                 |
| AI tools and `find_capabilities`        | `packages/core/src/addons/ai.ts`, `assistant/tools-addons.ts`; `apps/worker/src/assistant/tools-addons.ts`                                                    |
| Worker: reconcile, delivery, guards     | `apps/worker/src/addons/`; the guards in `jobs.ts` and `deliveries.ts`                                                                                        |
| Web: registry, gate, slots, menu places | `apps/web/src/addons/`, `components/addons/`, `app/app/w/[workspaceId]/a/`; `packages/core/src/account/menu.ts`                                               |
| Database                                | migrations `20261013000100` to `20261013000500`                                                                                                               |
| Starting one                            | `pnpm addon:new <id>` (`scripts/addon-new.mjs`, templates in `addons/_template/`)                                                                             |
| Tests                                   | `packages/core/test/addons/`, `addon-lifecycle.test.ts`; `packages/db/test/addons-rls.test.ts`; `apps/worker/test/addons.test.ts`, `assistant-addons.test.ts` |

An add-on's own code sits in the layer it belongs to, under its id:

```
packages/core/src/addons/<id>/manifest.ts   what it is (browser-safe)
packages/core/src/addons/<id>/server.ts     its commands and queries
apps/worker/src/addons/<id>/index.ts        its subscribers, jobs and lifecycle hooks
apps/web/src/addons/<id>/                   its components; its pages under app/app/w/[workspaceId]/a/<id>/
supabase/migrations/…_addon_<id>.sql        its permissions, and its own tables in schema addon_<id>
```

Each is registered by one line in an explicit list (`ADDON_CATALOG`, `ADDON_SERVER_MODULES`,
`ADDON_WORKER_MODULES`, `ADDON_UI`). Nothing registers itself by being imported.

## The pieces

- **The manifest** (`defineAddon`): its id (2–16 lowercase letters, never reused), name, catalogue status and
  keywords, the capabilities it gives, its permissions, what it requires (`required` or `optional`), its kinds of
  records and relationship types, the events it emits and consumes, its jobs, what it holds at providers, its
  settings and switches, its menu places and panels, and one line for the AI. `manifestIssues` and
  `catalogIssues` hold it to the rules (names under its id, the database's own limits, no dependency cycles, a
  planned add-on declares no code); the catalogue tests run them on every build.
- **Catalogue status**: `planned` (a promise: never installable, never offered), `development` (offered nowhere),
  `beta` and `built` (staff hand it out), `available` (anyone who manages add-ons installs it), `deprecated` (runs
  where installed, offered to nobody), `unavailable` (runs nowhere). HandsFreeOS staff can push an add-on down to
  `deprecated` or `unavailable` everywhere at once (`platform.addon_overrides`), never up.
- **An installation** (`app.addon_installations`): its state, the code version, the shape its data and settings
  are at, its settings and switches, and a generation that goes up on every reinstall. States: `installing`,
  `enabled`, `disabled`, `uninstalling`, `uninstalled`, `purging`, `purged`. Only `enabled` runs.
- **Capabilities**: what a business can do, core's and its add-ons', worked out in code as five sets for the
  person asking — current, restricted (on, but not for them), turned off, installable, planned. The screens, the
  API and the AI all read the same sets.
- **Operations**: an add-on's business logic is ordinary commands and queries (`defineAddonCommand`,
  `defineAddonQuery`), stamped with the add-on. The UI, workflows, the Assistant and other add-ons reach it the one
  way they reach core: through the kernel.
- **Records**: an add-on's things are custom records of kinds it manages (`app.custom_record_types.addon_id`), so
  timelines, tasks, files, appointments, relationships, fields and search work on them unchanged. Its own tables,
  when it needs them, live in `addon_<id>`, each with every tenant rule from `private.addon_table_policies()`.

## The lifecycle

A person moves an add-on with `addon.install`, `addon.enable`, `addon.disable`, `addon.uninstall` and
`addon.purge`. Each is planned from the catalogue first (`planTransition`), checked again in the database
(`private.addon_move`), and recorded as an event. The worker's `addon.reconcile` job, queued by that event, does
the slow part and proves it:

| State          | What the worker does                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installing`   | waits for what it requires; makes (or finds again) its kinds and types; brings data and settings up a version at a time; `onInstall`; turns it on; `onEnable` |
| `enabled`      | shows its records; `onEnable`                                                                                                                                 |
| `disabled`     | cancels its queued jobs and provider messages; hides its records; `onDisable`                                                                                 |
| `uninstalling` | the same, then lets go of everything in `app.addon_resources`; `onUninstall`; marks it uninstalled                                                            |
| `purging`      | deletes its data in batches (`private.purge_addon_batch`); marks it purged                                                                                    |

Every move ends with `private.addon_verify`: no permission held while off, no job or delivery waiting, its kinds
hidden, nothing held at a provider after uninstalling, and after a purge no rows left, records reduced to their
names and history without its details. The answer is stored on the installation; a move with a failing check isn't
finished, keeps its state and says what's wrong. An hourly `addon.sweep` queues a reconcile for anything unfinished.

What each step does to what it owns:

|           | Its own tables | Its records     | Relationships on them | Core records | Settings | History                  |
| --------- | -------------- | --------------- | --------------------- | ------------ | -------- | ------------------------ |
| disable   | kept           | hidden          | hidden                | untouched    | kept     | kept                     |
| uninstall | kept           | hidden          | hidden                | untouched    | kept     | kept                     |
| reinstall | migrated       | shown again     | shown again           | untouched    | migrated | kept                     |
| purge     | deleted        | names kept only | deleted               | untouched    | deleted  | lines kept, details gone |

## Rules worth knowing before changing anything

**The owner's decisions (2026-09-28)** are in the code, not in configuration:

- Turning off or uninstalling an add-on another one needs **asks to turn off both** (`addon_required_by`, answered
  with `include`); installing one that needs another **asks to add both** (`addon_needs`). Nothing moves silently.
  An add-on already arriving isn't asked about again.
- An uninstalled add-on's data is **kept, hidden, until an owner deletes it**; reinstalling restores it.
- Deleting its data keeps **each record's name and every history line**, and drops the rest.
- Turning it off **stops its work and nothing goes out late**: its jobs are cancelled, and when it's back on its
  `onEnable` arms them again from now. Items that came due while it was off wait for a person.
- **Owners and admins** install, turn off and uninstall (`addons.manage`, customizable); **only owners** delete
  data (`addons.purge`, typing the add-on's name).
- The AI **asks only for sensitive steps**: look-ups and risk 0–1 changes run on their own, risk 2–3 wait for the
  person's OK, risk 4 is never offered.
- A turned-off add-on's **records are hidden until it's back on**.

**One check, every actor.** The kernel refuses an add-on's operation, and core's operations run by the system for
it, for people, the system, workflows and the AI teammate alike (`addon_inactive`, with the add-on's id in the
details). A command holds a key-share lock on the installation, so a disable waits for commands already running and
nothing starts after it.

**An add-on's permissions exist only while it runs.** They're declared per add-on in `app.role_permissions` and
`app.customizable_permissions`, and `private.permissions_for()` (the one copy of the rules) leaves them out unless
the add-on runs there. Row security, the kernel, the menu, the phone and the AI all read the stored answer, so
turning an add-on off takes it from everyone at once. A business can set them per role and per person like core's.

**Queued work carries its add-on.** `scheduleAddonJob` stamps the add-on and its generation; the job runner cancels
one whose add-on is off or was reinstalled since, before it runs, and one this build has no code for. The webhook
runner sets aside a delivery for an add-on that's off. Core's own jobs pay nothing for either.

**Events reach an add-on in a job of its own.** An event an add-on consumes queues one `addon.deliver` job per add-on
that runs in the business; each runs on its own with its own retries, as the system acting for that add-on. One
add-on's failure never holds up core's handlers or another add-on's.

**Core never points into an add-on.** No foreign key from `app` or `platform` into `addon_<id>`; an add-on's tables
reference core and cascade with the business. The catalogue test checks both.

**History says which add-on did what.** The kernel stamps `_addon` and `addon_id` on every event and audit row an
add-on's work causes, so it reads after the add-on is gone, and a purge knows exactly which details to drop.

**The AI sees only what it may use.** An add-on operation that declares `ai` becomes a tool, always behind tool
search, offered only while the add-on runs and the person holds its permission; the runtime refuses any tool it
didn't offer, and the business's ids always go on after the model's arguments. `find_capabilities` answers "can
this business do X" from the capability sets. It suggests an add-on only to people who manage add-ons, at most two,
only `available` ones, and only when nothing the business already has matches as well; it names a planned one only
when asked what's coming, and never as something to install.

**The web hides what isn't on.** The menu shows an add-on's places only while it runs and the person may open them,
keeping where the person put them while it's off. Every add-on page opens through `addonPage` (the gate), and a
panel on a core page (`<AddonSlot>`) is loaded only while its add-on runs, inside its own error boundary. Only the
web's registry imports an add-on's folder; a lint rule holds the rest of the web to it.

## Making an add-on

```
pnpm addon:new pm --name "Property Management" --summary "Properties, units, tenants and leases." --category industry
node scripts/supabase.mjs migration up --local
pnpm --filter @hfos/core exec vitest run test/addons/pm.test.ts
```

That writes its manifest, server half, worker half, first page, migration and test, and a line in each list. It
starts in `development`. Then, as it needs them: kinds of records and relationship types in the manifest (the
worker makes them), operations with `ai` for the Assistant, subscribers and jobs in the worker half (declared in
the manifest too), panels in the web registry, its own tables with `private.addon_table_policies()`, and
`dataMigrations` whenever its data changes shape (bump `dataVersion`).

## Not yet

- **Add-on workflow steps and triggers.** Workflows can't use an add-on's steps yet. When they can, a workflow
  holding a turned-off add-on's step is held and the owner told, and resumes when it's back (the owner's decision);
  uninstalling pauses those workflows. Today one whose saved steps can't be read is passed over without stopping
  the event (WF-3).
- **Billing.** Usage is counted (`app.addon_usage_events`, refused while off) but nothing is priced; a `paid` add-on
  can only be handed out by staff.
- **Add-on webhook routes.** The delivery guard is in place, but `app.webhook_deliveries.provider` is a closed list
  and the worker's HTTP server has no route for an add-on's provider.
- **Secrets.** A business can't yet give an add-on its own credentials.
- **The screens.** The Add-ons page, an add-on's settings page, the recommendation card and the Action Center's
  add-on sources come with the first add-on. The API behind them is here.
- **The AI teammate** doesn't use add-on tools yet, and a multi-step plan isn't confirmed as a whole.
