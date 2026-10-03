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

| What                                    | Where                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifests, catalogue, rules (pure)      | `packages/core/src/addons/` (`manifest.ts`, `catalog.ts`, `graph.ts`, `lifecycle.ts`, `capabilities.ts`, `plan.ts`, `recommend.ts`)                                                                                                      |
| The planned add-ons and the vote        | `packages/core/src/addons/planned.ts`, `roadmap.ts`, `roadmap-load.ts`; `commands/addon-roadmap.ts`, `queries/addon-roadmap.ts`; the worker's `addons/roadmap.ts`                                                                        |
| Server half: operations, registry       | `packages/core/src/addons/server.ts`, `modules.ts`, `load.ts`; the kernel's check in `kernel/execute.ts`                                                                                                                                 |
| Lifecycle commands and queries          | `packages/core/src/commands/addon.ts`, `queries/addon.ts`, `schemas/addon.ts`                                                                                                                                                            |
| What the pages say, and Home's pick     | `packages/core/src/addons/words.ts` (words and move rules both apps use), `suggest.ts`                                                                                                                                                   |
| The Add-ons page and Home's card        | web: `apps/web/src/components/settings/add-ons/`, `components/home/addon-suggestion.tsx`; phone: `apps/mobile/src/add-ons/`, `components/add-ons/`                                                                                       |
| AI tools and `find_capabilities`        | `packages/core/src/addons/ai.ts`, `assistant/tools-addons.ts`; `apps/worker/src/assistant/tools-addons.ts`                                                                                                                               |
| Worker: reconcile, delivery, guards     | `apps/worker/src/addons/`; the guards in `jobs.ts` and `deliveries.ts`                                                                                                                                                                   |
| Web: registry, gate, slots, menu places | `apps/web/src/addons/`, `components/addons/`, `app/app/w/[workspaceId]/a/`; `packages/core/src/account/menu.ts`                                                                                                                          |
| Database                                | migrations `20261013000100` to `20261013000800` (the vote is `20261013000800`)                                                                                                                                                           |
| Starting one                            | `pnpm addon:new <id>` (`scripts/addon-new.mjs`, templates in `addons/_template/`)                                                                                                                                                        |
| The first real one                      | Real Estate Agent (`realestate`, in beta): docs/realestate.md                                                                                                                                                                            |
| Tests                                   | `packages/core/test/addons/`, `addon-lifecycle.test.ts`, `addon-votes.test.ts`; `packages/db/test/addons-rls.test.ts`, `addon-votes-rls.test.ts`; `apps/worker/test/addons.test.ts`, `addon-roadmap.test.ts`, `assistant-addons.test.ts` |

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
- **Catalogue status**: `planned` (a promise: never installable, never offered, voted on), `development` (offered nowhere),
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
  A kind can be kept to the people on each record (`keptToTeam`, Real Estate step 4): see docs/relationships.md;
  a table about such records passes the record column to `addon_table_policies` and follows them.
- **Its own timeline lines and AI use** (Real Estate step 6): a command writes on a record's, a customer's, a
  company's or a lead's timeline with `addonTimelineLine(ctx, manifest, { words, body, tone, … })` (subtype
  `addon_line`: who did it, or the add-on's name when it did it itself, and its words); deleting the add-on's data
  keeps each line's who and when and drops its words. AI it uses is counted under `app.ai_usage` source `addon`
  with its id, and charged like any other.
- **Panels** go on a customer, a company, a record, a conversation, a **lead** (`lead.panels`, step 6), or Home.
- **Handing one out to try** (Real Estate step 2): HandsFreeOS staff with `platform.addons.manage` give one business
  an add-on in `development`, `beta` or `built` (or a paid `available` one) from **/admin/businesses/<id>**
  (`addon_grant.give`, kept in `platform.addon_grants`). It's then installable there, listed under Available to add
  with a Testing badge, and never suggested. Taking it back (`addon_grant.take_back`) stops new installs and
  uninstalls nothing.
- **Locked files** (Real Estate step 3): an add-on keeps a file for good with core's `file.lock` (a signed document).
  A locked file can't be deleted, renamed or unlocked by anyone (`file_locked`), stays locked if the add-on's data is
  deleted, and goes only with the whole business. The worker records every file's SHA-256 as it arrives.
- **Reading a PDF** (Real Estate round four): an add-on's worker half reads one of the business's files with
  `readFileBytes` (apps/worker/src/files/read.ts, which checks the file is the business's first), then
  `documentText` (apps/worker/src/files/document-text.ts) for its text, page by page, the same reader the knowledge
  base uses, with the size limit as a parameter. A PDF with no text (a scan) can go to the AI itself as a `document`
  content block (`packages/ai`, `AI_DOCUMENT_MAX_BYTES`, `AI_DOCUMENT_MAX_PAGES`), with both providers. What the AI
  says it found is checked against the words before anything is kept (each value's quote must be in the text), and
  what came from a scan says so. A person confirms what matters; the AI never changes a record on its own.
- **Alerts** (Real Estate step 5): what an add-on needs someone to see. Its worker calls `raiseAddonAlert(ctx, …)`
  (apps/worker/src/addons/alerts.ts) with its own key, a severity (`info`, `attention`, `at_risk`, `critical`), the
  words, one of its own pages (`/a/<id>/…`), one of its own permissions, and optionally a record, an audience, a due
  time and `needsAck`; `clearAddonAlert(ctx, key, reason)` takes it away. Core does the rest: a Home card
  (`addon_alert`) for everyone holding the permission (and in the audience, and seeing the record), a push (switch
  `addons`) and an email (`addonEmail`) once per thing it says, critical at any hour and the rest while the business
  is open. `info` only goes on Home. A person acknowledges one from its card (`addon_alert.acknowledged` reaches that
  add-on alone). Which severity, when to raise it higher and who the top alerts go to are the add-on's to decide.
  Phones keep the cards through `records_v1` (round six, below). The push opens the add-on's screen on a phone that
  has it and the web until then:
  an add-on names the pages the phone draws in its manifest (`ui.phone`), and the phone's build lists the screens it
  has (`apps/mobile/src/links/addon-screens.ts`), so no link changes when a screen arrives. Turning the add-on off
  clears its alerts (`no_alerts_showing`); purging deletes them (`no_alerts_left`).
- **What phones keep of an add-on** (Real Estate round six, 20261022000100). An add-on that works with no signal says
  so in its manifest's `offline`: the permission whose holders' phones keep it, and each of its tables with the
  record column it follows, the columns a phone needs (`manifestIssues` refuses one that looks like a secret) and its
  reach (`team`: the record's owner and team; `all`: also whoever sees every record of the kind, for summary rows).
  Its migration says the same with `private.addon_phone_addon(...)` and `private.addon_phone_table(...)`, which
  installs triggers that copy just those columns into `app.addon_phone_rows` with the record's seals, and a test
  holds the two equal. Its private records, and the tasks, files, appointments, portal threads and Home cards on
  them, reach the same people through the same stream (`apps/sync/README.md`, `records_v1`). Turning the add-on off
  takes its permissions, so its keys, and every row leaves phones with nothing deleted. A record leaves phones
  earlier when the add-on says so (`private.record_phone_window`). An operation a phone may queue says
  `offline: 'anytime'` (or `freshMinutes`) and takes the phone's id for anything it makes.
- **Holds** (round six, 20261022000200). A record can be on hold: `retention` while the add-on keeps it (Real Estate:
  open deals, and closed ones for the years its settings say), set by the add-on as the system
  (`private.set_retention_hold`); `legal` placed and lifted by owners and admins (`records.hold`, a reason to lift).
  While any hold lasts, purging the add-on's data is refused with how many records and until when, and a legal hold
  also stops its files and timeline lines being deleted and the whole business being deleted.
- **A customer's portal** (Real Estate round two, steps 2–3). Core signs customers in: a business lets one in
  (`portal_access.give`), the worker emails a private link, and each new device types a six-digit code emailed to
  the address on file. A signed-in device is a `customer` actor. An add-on shows a customer its records like this:
  - A relationship type with `portal: true` (person ↔ one of its kinds) shows each record to the customer on it,
    while the add-on runs (`portal.records()`).
  - Operations for customers list `actors: ['customer']` alone, are named `<id>.portal.*`, ask no permission,
    carry no `ai` and are risk 2 at most (`customerOperationIssues`). The worker serves them at
    `POST /public/portal/op/<name>` for a signed-in device; they're never in the API.
  - A customer's look-up runs as `portal_actor` under row security. That role reaches only `app` and its own
    schema, `portal`, never `private`. Their change runs as the service actor, so its
    handler checks the record is theirs (`private.portal_records_for(workspace, person)`); history records it as the
    customer, on channel `portal`. Either way the device must still be signed in.
  - Its own table opens to customers with `private.addon_portal_policies(table, record column, columns)`, select only,
    and only the columns named.
  - Its portal pages go in the manifest (`ui.portal`: a path, a title and the customer query it shows).
  - Core gives every portal files (`portal.upload_begin`/`confirm`, `portal.files`, `file.share_to_portal`) and
    messages (`portal.message_send`, `portal.messages`, `portal.mark_read`; the team answers on channel `portal`).
    A portal thread is about one record, so a private record's thread is seen only by the people on it.
  - On the web, core draws the portal at `/c/<link>` (`apps/web/src/components/portal/`): the sign-in, the frame,
    Home, Messages and Files, all read in the customer's browser with the device's own sign-in
    (`lib/api/public-portal.ts`). An add-on's part is its registry entry's `portal`: a card or two on Home
    (`home`) and its pages (`pages`, one component handed the path), opened at `a/<id>/<path>` only for a path
    its `ui.portal` declares. Its pages without an id (Real Estate's Homes and To do) are places in the portal's
    menu, between Home and Messages. They read and act through `usePortal()`, never holding the sign-in.
- **Public pages** (Real Estate round three, step 1): pages anyone with the link opens, signed out, under the
  business's booking site at `/a/<site>/<id>/<path>` (on its own domain too). They run as a `public` actor, in the
  business whose site it is, as the service actor there on the forms' channel, and stop while the add-on is off.
  - Operations for visitors list `actors: ['public']` alone, are named `<id>.public.*`, ask no permission, carry no
    `ai` and are risk 2 at most (`publicOperationIssues`): one can make a customer and a lead.
  - The manifest's `ui.public` names each page (`{ path, query }`, `:name` for a part of the path) and the public
    query it shows. The worker serves them at `POST /public/addon/:site/query/:name` and `…/command/:name`, with the
    forms' per-address limits, the honeypot and the bot check on changes, and `no-store`. Every `{ publicFileId }` in
    an answer gets a `url` that works for an hour, once the file is checked to be the business's own.
  - A visitor who leaves their name goes through `signUpFromPage` (`crm/signup.ts`): the customer is found or made,
    a lead opened where the business's forms would, and a yes to texts kept with where it came from. A command that
    calls it lists `SIGN_UP_EVENTS` in its `emits`.
  - On the web, `apps/web/src/app/a/[site]/[addonId]/[...path]/` matches the path to `ui.public`, reads its query
    on the server, and the registry's `public` entry draws it (`pages`, one component handed the answer, and the
    tab's `title`). Its forms post from the visitor's browser (`publicAddonCommand`), with core's words for agreeing
    to texts (`smsConsentWords`).
- **Connections to other services** (Real Estate round five, step 1): an add-on's manifest names what it connects
  (`connectors`: a key such as `listing_data`, the permission it takes to manage it, `many` when a business may
  connect more than one at a time) and the services for each (`providers`: an id, a label, how each connects —
  `key`, `oauth` or `platform` — and the fields a key needs, with `secret` on the ones to hide).
  - A business's account is a row of `app.addon_connections`. A key is pasted on its Connections screen and posted to
    the worker (`POST /v1/addons/connections/key`, apps/worker/src/http/addon-connections.ts): the add-on must be on,
    the person must hold the connector's permission, and the add-on's worker half tries the key with the service
    (`connectors[key][service]`, a `ConnectionTester`) before anything is kept. Only then does the worker seal it and
    save it (`addon_connection.save`, as the system acting for that person). A refusal (`ConnectionRefused`) says
    what the service said; a service that doesn't answer keeps nothing.
  - Nobody reads a sealed column back, owners included; only the people with the connector's permission see the
    row at all (`addon_connection.list`). Anyone who uses the add-on may ask whether it works
    (`private.addon_connection_live`).
  - **HandsFreeOS's own account** at a service (`platform`) is turned on for a business by staff
    (`addon_connection.platform`); its key lives only in the worker's environment, `ADDON_PLATFORM_KEYS`, by
    `<add-on>.<service>`, and the API refuses to start with it. The business's own account is used before it, and
    for a connector that isn't `many`, connecting a new service lets the business's other one go.
  - The add-on's worker half asks for the account to use now with `connectionFor(ctx, connector)`, which opens the
    key only then, and reports each call with `connectionWorked(ctx, connection, result)`: failures count, a
    refusal needs the key again (`reauth_required`), five in a row read `error`, and one that works clears them.
    The moves between working and not are events (`addon_connection.failing`, `addon_connection.working`).
  - Letting one go (`addon_connection.disconnect`) wipes its key there and then. Uninstalling the add-on wipes every
    key it holds; purging its data deletes the rows.
  - Locally and in tests, `ADDON_CONNECTORS=fake` (the default outside production) tells each tester to use its
    stand-in, and nothing leaves the worker; HandsFreeOS's own account works there without a key.
- **Its own browser-test routes**: a worker module's `testRoutes(app, deps)` adds `/test/<id>/…` routes beside the
  worker's other test routes, only with the fake providers. Core never imports an add-on's folder for them.
- **Connecting by sign-in** (Real Estate round five, step 7): a service with `oauth` in its provider's `auth` is
  connected by signing in to it. The add-on's worker half says how (`oauth[key][service]`: `authorizeUrl`,
  `exchange`, `refresh`; apps/worker/src/addons/sign-ins.ts), and HandsFreeOS's app at the service (its client ID and
  secret) is in `ADDON_PLATFORM_KEYS` under `<add-on>.<service>`.
  - It works as every sign-in here does (http/addon-sign-ins.ts): `POST /v1/addons/connections/sign-in` keeps a
    one-time state (hashed) and a PKCE verifier (sealed) for ten minutes; the callback connects nothing and hands a
    seal to the app (`/app/oauth/finish?door=addon`); only the person who pressed Connect finishes it
    (`POST /v1/addons/connections/finish`), and anybody else ends it. The tokens are sealed and kept, and the browser
    goes back to the add-on's Connections.
  - `signedInTokens(ctx, connection, provider)` renews the tokens when they're about to lapse; a renewal turned down
    asks for the sign-in again (`reauth_required`).
  - With the stand-ins the sign-in page is the worker's own (`/oauth/fake/addon/…`) and the tokens are made up.
- **Its worker actions** (Real Estate round five, step 7): something a person needs from a connected service right
  now, which only the worker can ask, is one of its worker module's `actions` (`permission`, `input`, `run`), at
  `POST /v1/addons/<id>/actions/<name>` (apps/worker/src/http/addon-actions.ts). The add-on must be on and the person
  must hold the permission; it runs as the system acting for the add-on, on their behalf, and checks they may see
  what it's about (`private.user_sees_record`). DocuSign's sending page, made fresh for whoever opens it, is one.
- **A file the worker brings back** (a document signed at DocuSign, say) is uploaded to its place on the record
  (`storedFilePath`) and kept with core's `file.store`, as storage measured it, on the timeline. The add-on then
  files it its own way (Real Estate makes it a locked document).
- **A service's updates** (Real Estate round five, step 2): a service that sends updates says so in the manifest
  (`webhooks: true` on its provider), and the add-on's worker half has a receiver for it (`webhooks[key][service]`:
  `verify`, `parse`, `handle`; apps/worker/src/addons/webhooks.ts).
  - `openConnectionWebhook(ctx, connection, { secret })` gives a connection its own address,
    `<WORKER_PUBLIC_URL>/webhooks/addon/<token>`, replacing any it had; the add-on hands it to the service. Only the
    token's hash is kept, and the service's signing secret is sealed (`'generate'` makes one to give it).
  - The route (apps/worker/src/http/addon-webhooks.ts) finds the connection by the address, has the receiver check
    the signature over the exact text that arrived (a 403 keeps nothing) and read what happened, and keeps each
    update once, by the service's own id on that connection (`app.webhook_deliveries`, provider `addon`).
  - The delivery runner hands each one to `handle` with the connection it came in on, with retries, and sets it aside
    while the add-on is off. A service that doesn't sign is kept with `signed: false`: read what changed back from the
    service rather than trusting what was sent.
  - An address that was replaced, or whose connection was let go, is a 404. An add-on hears about its own
    connections through `addon_connection.*` events, and no other add-on does.
- **Campaigns from exact words** (Real Estate round three, step 2): an add-on can start a campaign with its own words
  (`campaign.create` with `words`: `{ text }`, or `{ subject, body }` for an email) through `executeCommandWithin`,
  as the person who clicked. The AI writes nothing; who it picks and leaves out, approval and every consent rule are
  Campaigns' own, unchanged.

## The lifecycle

A person moves an add-on with `addon.install`, `addon.enable`, `addon.disable`, `addon.uninstall` and
`addon.purge`. Each is planned from the catalogue first (`planTransition`), checked again in the database
(`private.addon_move`), and recorded as an event. The worker's `addon.reconcile` job, queued by that event, does
the slow part and proves it:

| State          | What the worker does                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `installing`   | waits for what it requires; makes (or finds again, keeping any name the business gave them) its kinds and types; brings data and settings up a version at a time; `onInstall`; turns it on; `onEnable` |
| `enabled`      | shows its records; `onEnable`                                                                                                                                                                          |
| `disabled`     | cancels its queued jobs and provider messages; hides its records; `onDisable`                                                                                                                          |
| `uninstalling` | the same, then lets go of everything in `app.addon_resources`; `onUninstall`; marks it uninstalled                                                                                                     |
| `purging`      | deletes its data in batches (`private.purge_addon_batch`); marks it purged                                                                                                                             |

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

**An add-on whose code is gone** (retired: taken out of HandsFreeOS while a business still has it) can still leave:
`addon.uninstall` and `addon.purge` work without its code, and the worker does both by its id. Nothing turns it on
or off again, and it goes by its id, which is also the name an owner types to delete its data.

## The Add-ons page

**Add-ons**, a place of its own at the foot of the web's side menu (beside Ideas and Get help) and under **More** in
the phone app, is for owners and admins (`addons.manage`); nobody else sees it. It was a Settings tab until the owner
moved it (2026-09-28); the old address, `/settings/add-ons`, still leads to it. It has four parts: what the business has (every installation, whatever its state), what it could add
(what HandsFreeOS says is installable here, and paid add-ons, which say HandsFreeOS support can turn them on),
Coming soon (what the vote picked, until it can be added), and Vote on what's next (every planned add-on still up
for a vote; see below). A beta or built add-on is offered only to a business HandsFreeOS staff handed it to (a
grant), marked Testing.

- **Both apps say the same thing.** Every word on the page, and the moves each state offers (`addonMovesFor`), come
  from `packages/core/src/addons/words.ts`.
- **Taking something away asks first.** Before turning an add-on off, uninstalling it or deleting its data, the page
  shows `addon.impact`: HandsFreeOS's question about the add-ons that need it (and a button that names them: "Turn
  off both"), what stops, who does less without it, and what it holds here. Deleting data asks an owner to type the
  add-on's name.
- **It follows the worker.** A state on its way (Setting up, Uninstalling, Deleting its data) shows progress and
  offers no move; the page redraws on every add-on event and asks again every few seconds meanwhile. Trouble is
  said in the checks' own words, and only while it's current.
- **Settings.** Its switches are saved one at a time. An add-on's own settings form is `settings` in the web's
  registry, loaded when it's opened and drawn in its own error boundary.

**Home's card.** Now and then Home suggests one add-on that fits the business (`suggestAddon`): only to owners and
admins, only an available, free add-on that `recommendAddons` would name from the business's name, its line of work
and the kinds of records it made for itself, and one card at most. "Not now" quiets every suggestion for that person
for 30 days; "Not interested" never shows them that add-on again (`app.addon_suggestion_dismissals`, each person's
own).

## Voting on what's next

The catalogue lists every add-on HandsFreeOS plans to build (`planned.ts`: the owner's list of 2026-09-28, without
duplicates or what core already does), each with a category and the groups the list filters by. Businesses vote on
them, and each week's winner becomes Coming soon. Real Estate Agent was already next, so it started as Coming soon.

- **The list** (`addon.roadmap`) is searchable and filters by category and group, sorted by votes or A to Z. The
  search, filters and order are core's (`filterPlanned` and the rest of `roadmap.ts`), so both apps agree.
- **A vote** (`addon.vote`, `addon.unvote`) is the business's, cast by its owners and admins. Votes live in
  `platform.addon_votes` beside the ideas board, with the counts kept by a trigger (`platform.addon_vote_counts`).
- **The week** closes every Sunday at midnight, US Eastern (`nextAddonPickAt`). The worker's `addon_roadmap.week`
  job hands the database the add-ons still in the race (planned, not picked), and `private.close_addon_vote_week`
  picks the one with the most votes into `platform.addon_picks`. With nothing voted for, or a tie, nothing is
  picked: the staff who hold `platform.addons.manage` are emailed and choose on **/admin/add-ons**
  (`addon_pick.choose`; for a tie, among the tied ones).
- **Telling people.** The owners and admins of every business that voted hear by email and on Home (`addon.news`)
  when their add-on is picked, and again when it ships. Shipping is a deploy that makes it `available`: the
  hourly `addon_roadmap.ship_check` (and one soon after the worker starts) writes it down and sends the second
  email. Each email is recorded (`platform.addon_pick_deliveries`), so a retry tells nobody twice.
- **Building one** starts it under its planned id (`pnpm addon:new realestate …`): its manifest replaces the planned
  one in `ADDON_CATALOG`, and its pick and votes carry over.

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
- **Voting on what's next**: one vote per business, on as many planned add-ons as it likes, cast by owners and
  admins; votes never expire and show their counts; every Sunday at midnight, US Eastern, the one with the most
  votes becomes Coming soon, and with no votes or a tie the team chooses; Coming soon stays until it ships; voters
  hear by email and on Home when it's picked and when it ships. Only planned add-ons that nothing in core already
  does are on the list.
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
web's registry imports an add-on's folder; a lint rule holds the rest of the web to it. HandsFreeOS support looking
at a business sees its add-ons' pages as it sees core's: read-only (the owner's decision).

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

What's decided but not built, with the owner's decisions (2026-09-28) that shape each:

- **Downloading a turned-off add-on's records.** Its records are hidden until it's back on, and owners may still
  take a copy; the download isn't built.
- **Add-on workflow steps and triggers.** Workflows can't use an add-on's steps yet. When they can, a workflow
  holding a turned-off add-on's step is held and the owner told, and resumes when it's back (the owner's decision);
  uninstalling pauses those workflows. Today one whose saved steps can't be read is passed over without stopping
  the event (WF-3).
- **Billing.** Usage is counted (`app.addon_usage_events`, refused while off) but nothing is priced; a `paid` add-on
  can only be handed out by staff. Each paid add-on will have a monthly price, usage from the wallet, or both.
- **The AI teammate.** It doesn't use add-on tools yet. It will look things up in add-ons on its own and take their
  actions only with a person's OK. A multi-step plan isn't confirmed as a whole either.
- **Real Estate Agent's later rounds.** Its first four rounds (deals, duties, dates, proof, documents, alerts, the
  duty editor, client updates; the buyer's side and the client's portal; the listing's side, its public pages and
  the seller's portal; reading contracts, contingencies, duty order, linked deals, escalation and Coordinate) are
  built and in beta (docs/realestate.md), and so is its fifth (listing data, e-sign, showings and vendors, on
  connections and a service's updates). Its sixth, the phone and the finish, has its server built (what phones keep,
  holds, check-ins, field notes, the walkthrough and the export); its phone screens wait on their boards. Everyone
  else still sees it as Coming soon.
