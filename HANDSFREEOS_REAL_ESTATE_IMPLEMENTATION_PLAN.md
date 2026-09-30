# Real Estate Agent — the first add-on, round one

Real Estate Agent is HandsFreeOS's first real add-on. It was Coming soon before any vote, and it is built
under its planned id, `realestate`. Chris's specification ("HandsFreeOS Real Estate Add-On Specification",
v1.0, 30 September 2026) describes the whole of it: 148 duties an agent, a coordinator and the people around a
home sale carry, the trackers that watch them, and five releases. Its promise: if a duty matters, HandsFreeOS
knows it, gives it an owner, knows when it's due, watches what it waits on, keeps the proof, and speaks up when
it's late or stuck, even when the work itself stays human.

This round builds the specification's **Foundation**: deals, the duty engine with every one of the 148 duties,
dates that follow the contract, proof, documents that can't be lost, health, alerts, a duty editor, the
Assistant, and AI-written client updates the agent approves. It builds four pieces of core first, because the
add-on needs them and core should own them: records kept to the people on them, add-on alerts on Home and the
phone, signed files that can't be deleted, and a way for staff to hand an unfinished add-on to a test business.

The buyer and listing workspaces (search, tours, comparisons, offers back and forth, marketing), reading
contracts, the MLS and other connectors, a client portal and phone screens come in later rounds.

## Decisions (Chris, 2026-09-30)

| Question                               | Answer                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How far this round goes                | **The Foundation release**, web first. Phone screens later.                                                                                                                                                                    |
| What core doesn't have yet             | **Left out**, except four pieces built in core first: private deals (with support access), add-on alerts on Home and the phone, locked documents, and staff handing out a test add-on.                                         |
| Who it's for                           | **Solo agents, small teams and brokerages.**                                                                                                                                                                                   |
| Where                                  | **US-wide basics.** Business days are Monday to Friday minus US federal holidays (as observed), in the business's time zone. No state rules; each business adjusts its own defaults.                                           |
| What a piece of work is called         | **A deal** ("the Smiths buying 123 Main St", "listing 45 Oak Ave"). Kept apart from the Pipeline's "deals" wherever the two could meet.                                                                                        |
| Who sees a deal                        | **Only the people on it.** Owners, admins and anyone given **See every deal** see all.                                                                                                                                         |
| Who puts people on a deal              | **Its main agent**, and owners and admins on any deal.                                                                                                                                                                         |
| Both sides of one home                 | **Two linked deals**, a buyer deal and a listing deal sharing one property.                                                                                                                                                    |
| Done without its proof                 | **Owners and admins** may complete a duty without its proof, with a reason (`realestate.except`, which owners can give others).                                                                                                |
| Alerts                                 | **Email, phone push and Home cards.** Critical ones go out at any hour; the rest wait for the business's working hours.                                                                                                        |
| Who hears when it's critical           | **A person the business picks**, like the managing broker. Owners when nobody is picked.                                                                                                                                       |
| The Tasks list                         | **Duties stay in the add-on**, so a proof rule can't be skipped by ticking a task somewhere else.                                                                                                                              |
| The Assistant                          | **Answers, and changes things after a person's OK** (risk 2 and 3 wait for the OK, as for every add-on).                                                                                                                       |
| New duties                             | **Everyday duties start at once. Duties from contract dates start as drafts** until an agent or coordinator confirms the dates.                                                                                                |
| A date with no time                    | **Due at 11:59 pm** that day, in the business's time zone.                                                                                                                                                                     |
| A calendar-day deadline on a weekend   | **Keep the date and warn.** Contracts differ, so the add-on doesn't guess; the agent can move it with a reason.                                                                                                                |
| Signed documents                       | **Never deleted**, only replaced by a newer version marked as the one that counts. They stay locked even if the business later deletes the add-on's data.                                                                      |
| Lenders, title, inspectors, other side | **In the business's contacts**, linked to each deal with their role.                                                                                                                                                           |
| The duty list                          | **A full editor now.** Owners and admins turn duties off, change timing, reminders and proof, and write their own duties. The list is versioned.                                                                               |
| Changing a duty                        | **Changes new deals only.** Open deals keep the version they started with; an owner or admin can apply the new one to an open deal by hand.                                                                                    |
| Clients                                | **Status emails the agent approves.** The AI writes a draft from the deal's facts at big milestones (under contract, inspection done, clear to close, closed) and whenever the agent asks. The agent edits and sends.          |
| Which mailbox                          | **The agent's own, when they have one**, else the team inbox. The agent can switch before sending.                                                                                                                             |
| Fair housing                           | **Every AI draft is checked.** A flag shows the words, why, and a safer wording; the agent fixes it or confirms with a reason. Both are kept.                                                                                  |
| Offers and contracts                   | **Key dates and terms typed in**, each with its source and its full history when an amendment changes it. Conflicts are never settled silently. Offers and counters back and forth come later.                                 |
| Commission                             | **Agreed, seller credit, brokerage split and expected** on every deal. **The final amount is set by owners and admins.**                                                                                                       |
| The Pipeline                           | **Keeps new inquiries.** "Start a buyer deal" and "Start a listing" on a lead or a customer open the deal, linked back. Closing a deal offers "Mark the lead won too?", never on its own.                                      |
| Properties                             | **Shared** with everyone who has the add-on. Deals on a property stay private.                                                                                                                                                 |
| Appointments on a private deal         | **Visible as busy, the deal link hidden**, so nobody double-books. The add-on makes no appointments this round.                                                                                                                |
| Removing a deal                        | **Never deleted, only archived.**                                                                                                                                                                                              |
| HandsFreeOS support                    | **Can't see private deals.** The deal's agent or an admin gives access, or support asks and one of them approves. It lasts **24 hours**, can end sooner, and covers **every deal the approver can see**. The founder sees all. |
| The phone's data                       | **Narrowed now** so a private deal's files, notes and tasks never reach the phone of someone not on it. Nobody uses the phone app yet, so the one-time copy doesn't matter.                                                    |
| Release                                | **Hidden.** It stays `development`, then `beta`; staff hand it to test businesses. Coming soon for everyone else until the later rounds are built.                                                                             |
| Price                                  | **Free for now.** Usage is counted. AI drafts count like any other AI use.                                                                                                                                                     |
| Screens                                | **Design boards first**, in `design/realestate`, reviewed before the screens are built.                                                                                                                                        |

Chosen for Chris, open to change:

- Waiving a duty takes the same permission as completing one without its proof (`realestate.except`).
- The four catalog rows that describe how the product itself behaves (X-13 the document vault, X-14 version
  control, X-44 the rule engine, X-45 the health monitor) are not duties on a deal. The duty editor lists them
  as "HandsFreeOS does this".
- The person who hears critical alerts must be an owner or hold See every deal; anyone else falls back to the
  owners.
- A phone push about a deal opens its web page, since the phone has no add-on screens yet.

Carried over, not re-asked:

- Every change is a command, row-level security decides who sees what, and the add-on works through core's
  records (docs/addon-architecture.md).
- The owner's add-on decisions of 2026-09-28: turning it off stops its work and nothing goes out late; its
  records are hidden while it's off; deleting its data keeps names and history lines; owners and admins install
  it; only owners delete its data.
- The hosted database gets each migration before `main` does.

## Where it stands today

| Piece                               | Before this round                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built add-ons                       | None. `BUILT_ADDONS` is empty; `realestate` is planned, picked, and Coming soon.                                                                                             |
| Handing a test add-on to a business | Not possible. `installableHere` (`packages/core/src/addons/capabilities.ts`) offers only `available` add-ons.                                                                |
| Custom records                      | Everyone in the business reads all of them. No owner, no team.                                                                                                               |
| What hangs off a record             | Timeline lines, tasks, files (and their Storage objects), appointments and relationships are readable business-wide; files, tasks, lines and Home cards sync to every phone. |
| Files                               | Anyone who may write records may delete one. No lock and no fingerprint.                                                                                                     |
| Home cards                          | `ATTENTION_KINDS` is a closed list with a database check and about sixteen lists that name every kind.                                                                       |
| Push                                | Ten fixed switches and a fixed list of categories (`packages/core/src/push.ts`, `private.push_on`).                                                                          |
| Business days and holidays          | None. Only the time-zone helpers (`calendar/engine/zoned.ts`) and open hours (`attention/open-time.ts`).                                                                     |
| Tasks                               | Open or done; nothing a duty needs (proof, blockers, dependencies).                                                                                                          |
| The lead page                       | No place for an add-on's panel.                                                                                                                                              |
| AI use by an add-on                 | No source to count it under (`app.ai_usage_source`).                                                                                                                         |
| Support looking at a business       | Read-only, with a reason, for a while, and the business sees it (M13). The founder opens any business as its owner.                                                          |
| Emailing a customer                 | Built: `message.send`.                                                                                                                                                       |

## How it works

### Deals, properties and the people around them

- **A deal** is a record of the add-on's kind `realestate_deal` (icon `key`), so its timeline, files,
  relationships and search work as for any record. Its details are a row in `addon_realestate.deals`, one to
  one: its side (`buyer` or `listing`), its stage, the lead it came from, its commission, and its health.
- **A property** is a record of the kind `realestate_property` (icon `home`, named by its address), shared with
  everyone who has the add-on. A deal points at one property (a many-to-one relationship type); a buyer deal
  may have none until an offer is accepted.
- **Two linked deals**: `addon_realestate.deal_links` joins a buyer deal and a listing deal on the same home
  (`same_home`), or a client's sale and next purchase (`sale_and_purchase`).
- **Clients and outside parties** are the business's own people and companies, joined to a deal by the add-on's
  relationship types, one per role: client, loan officer, other side's agent, title contact, inspector, vendor
  and attorney for people; lender, title company, brokerage and vendor for companies. A lender used on five
  deals is one contact with five links.
- **The team on a deal** is the record's owner (its main agent) and team. `addon_realestate.deal_roles` names
  what each does there: agent, co-agent, coordinator or assistant.
- **Stages.** A buyer deal runs lead → onboarding → representation → financing → searching → touring → offer →
  negotiation → under contract → inspections → appraisal → financing and title → closing → possession → past
  client. A listing runs seller lead → consultation → signed → pre-listing → coming soon → active → showings →
  offers → negotiation → under contract → inspection → appraisal → financing and title → closing → sold → past
  client, with withdrawn, expired and cancelled as stages of their own. A deal moves forward to any later
  stage; it moves back only through a named event (an offer lost, a termination, back on market), which keeps
  its history. Every move is a line in `deal_history`.
- **Starting one.** "Start a buyer deal" or "Start a listing" on a customer, a company or a Pipeline lead
  (`realestate.deal.open`). The Pipeline keeps new inquiries; closing a deal asks once whether to mark its lead
  won.
- **Commission** in cents, as core's money is: basis (percent or flat), rate, seller credit, brokerage split,
  expected, and the final amount (`realestate.deal.set_final_commission`, owners and admins).
- **Archived, never deleted.** `realestate.deal.archive` archives the record through core.

### Keeping a deal to the people on it (core)

- A kind an add-on declares `keptToTeam` (with its See-every permission) makes each record of it private:
  `app.custom_records` gains `owner_user_id`, `team_user_ids` and `kept_to_team`; `app.custom_record_types`
  gains `kept_to_team` and `see_all_permission`. Only add-on kinds can be private in this round.
- **Who sees one:** its owner, its team, and anyone holding the kind's See-every permission (owners always
  hold every permission). The founder's session answers as an owner, so the founder sees all.
- **What follows the record:** timeline lines, tasks, files and their Storage objects, relationships, Home cards
  and the add-on's own tables. Each of those tables gains `sealed`, kept by a trigger from the record it hangs
  on, and every policy gains "and it isn't sealed, or its record is visible". Appointments stay on the calendar
  as busy with the link hidden. `private.custom_record_visible(id)` answers for the caller;
  `private.user_sees_record(user, id)` answers about someone else, for the worker.
- **Who changes the team:** the record's owner (its main agent) adds and removes people, and so does anyone
  holding `records.assign` (owners and admins). New people must work in the business. A task on a private record
  can only go to someone on it.
- **The add-on's own tables** use `private.addon_table_policies(…, p_record_column)`, so a row about a deal
  follows the deal.
- **The phone.** The `business_v1` stream narrows its tasks, timeline lines, files and Home cards to
  `sealed = false`, in place, as 0083 and M19 narrowed the inbox.
- **Support.** A support look (M13) sees no private record. `app.record_support_grants` holds an access: given
  by the deal's agent or an admin, or asked for by support and approved by one of them. It lasts 24 hours unless
  ended sooner, and shows support what the approver sees (`user_sees_record(granted_by, …)`), read-only, while
  their look is open. Every grant, request and ending is in the business's audit log.

### Duties

- **The catalog.** All 148 rows of the specification live in code (`packages/core/src/addons/realestate/catalog/`),
  each with its side, phase, words, tracker (one of the 24 in §16), when it's created, its due rule, the proof
  that finishes it, who is accountable, its automation level (A0 observe … AX never) and how much it matters
  (standard, material, critical). A row writes only what differs from its tracker's defaults. The catalog has a
  version; a test proves all 148 ids are there once.
- **When a duty is created.** Opening a deal and entering a stage create that stage's duties; a stage skipped
  creates its duties too, each cancellable with a reason. Confirming a contract term creates the duties that rest
  on it. Some rows depend on a fact about the home (HOA, well, septic, solar, financed).
- **Drafts first for contract dates.** A duty whose deadline comes from a contract date starts as a draft and
  becomes active once every date it needs is confirmed.
- **Statuses:** draft, waiting for approval, not started, in progress, waiting on someone, blocked, completed,
  waived, cancelled. **Overdue** is worked out from the due time, never stored.
- **Blocked** needs a blocker, whose it is, the impact, and when to look again. **Waiting on someone** names them.
  Being blocked never moves a due date.
- **Proof.** Each duty says what finishes it: a signed document of named kinds, a file, a note, a person's
  attestation ("I was there"), a core record (an appointment, a message, a task), or all or any of those. A
  message saying "done" is proof only where the rule allows it. `realestate.duty.complete` refuses with
  `duty_needs_proof` and says what's missing. Owners and admins may complete it without its proof, with a
  reason (`duty.complete_with_exception`), and may waive it.
- **History.** Every status change, reassignment, due change, piece of proof and exception is a line in
  `duty_log`, and the kernel's events and audit rows say whether a person, the system or the AI did it.
- **The editor.** A business's duty list is a published version (`template_sets`, with each item's resolved
  definition kept, so a version replays exactly). Owners and admins turn duties off, change timing, reminders,
  accountable role and proof, and write their own duties with the same rules. Publishing makes a new version;
  new deals take it, open deals keep theirs, and "Apply to this deal" moves an open deal on after showing what
  changes.

### Dates

- **Business days** are Monday to Friday minus the US federal holidays as observed (a Saturday holiday on the
  Friday before, a Sunday one on the Monday after), plus any days the business closes. Juneteenth counts from 2021.
- **Due rules:** on a date, N days or business days before or after a date or an event, every N days while in a
  stage, ongoing through some stages, or the earliest or latest of several. A date with no time is due at
  11:59 pm local. A calendar-day deadline on a weekend or holiday keeps its date and shows a warning.
- **Replayable.** Each resolved due time keeps its trace: the date it rests on, where that came from, the days
  skipped and why, and the holiday rules' version.
- **Terms and their history.** Each key date or term (acceptance, earnest money, inspection period, financing,
  appraisal, closing, possession, rate lock, price, and the rest) is an append-only entry with its value, its
  source (contract, amendment, counter, addendum, correction, lender, title, typed by hand), where in the
  document, and who confirmed it. An amendment supersedes the old value and keeps it in history; two confirmed
  values that disagree are a conflict that shows both and waits for a person.
- **Checks across the deal:** closing before acceptance, a contingency ending after closing, a rate lock ending
  before closing, no Closing Disclosure three business days before closing, closing on a weekend or holiday, a
  preapproval or buyer agreement ending before closing, and a linked sale closing after the purchase.

### Documents

- A document is a core file on the deal, with a row in `addon_realestate.documents`: its kind (buyer agreement,
  listing agreement, disclosure, contract, amendment, inspection report, invoice, photo, Closing Disclosure,
  and the rest), its version in a lineage, its status (draft, sent, signed, superseded, void), and whether it's
  the one that counts.
- **Marking one signed locks its file (core).** `app.files` gains `locked_at`, `locked_by`, `locked_reason`,
  `locked_by_addon`, `sha256` and `hashed_at`. A locked file can't be deleted, renamed or unlocked by anyone
  (`file_locked`); deleting the whole business still removes it. The worker records every file's SHA-256 when it
  arrives. Deleting the add-on's data leaves locked files locked on the client's record.

### Health and alerts

- **Health is explained, never a score.** Green, yellow or red, with the exact reasons: the duty or date, its
  owner, when it's due, the proof missing, and the next step. Red is a critical duty overdue, a material duty
  overdue by a business day, a material duty due within a business day and not moving, a conflict on a date that
  counts, a reported wire change, closing within two business days with material work open, or a rate lock or
  Closing Disclosure problem. Yellow is anything overdue, material work due within three business days and not
  started, anything blocked, a late reply, dates waiting to be confirmed, a missing key date, or a duty with
  nobody accountable.
- **The ladder:** a Home card seven days out; three days out and one day out a push (and email for material
  work); at the due time; overdue; at risk (the agent and the coordinator, with Acknowledge); critical (also the
  person the business picked, at any hour). Everything but critical waits for the business's working hours.
- **Add-on alerts (core).** `app.addon_alerts` holds what an add-on raises; one new Home card kind,
  `addon_alert`, shows it with the add-on's name, and one push switch, **Add-on alerts**, covers them. An alert
  on a private deal is sealed like the deal. Turning the add-on off clears its alerts, and `addon_verify` checks
  none are showing.
- **The sweep.** `realestate.sweep` runs every 15 minutes while the add-on is on. After being turned back on,
  thresholds already passed become Home cards only; nothing goes out late.
- **Wire changes.** "Wiring instructions changed" on a deal raises a critical alert at once and a duty that
  finishes only with an attested phone check. Nothing relays new instructions.

### The Assistant and client updates

- **The Assistant** can find deals, read one, list duties, and answer "what could stop the 123 Main closing?"
  on its own; opening a deal, entering dates, moving a stage, completing a duty and the other changes wait for
  the person's OK. It sees only the deals the person sees.
- **Client updates.** At a milestone, or when the agent asks, the worker gathers the deal's facts (the address,
  the stage, confirmed dates, what's done and what's next in client words, the agent's name, the client's first
  name; no notes) and asks the model for a subject and body. The agent edits it and sends it with `message.send`
  from their own mailbox or the team inbox. It counts as AI use under "Real Estate".
- **Fair housing.** Every draft is checked twice: a fixed list of words and phrases per protected class and
  proxy (with the reason and a safer wording), and the model. Flags show before sending; the agent fixes them or
  confirms with a reason. Each check, its version and its result are kept.

### Staff hand out a test add-on (core)

- `platform.addon_grants` lets HandsFreeOS staff (`platform.addons.manage`) give one business an add-on still in
  `development` or `beta`. It then shows on that business's Add-ons page under what it could add, marked
  Testing, and its owners and admins install it as usual. Taking the grant back stops new installs; it doesn't
  uninstall.

## Permissions

| Permission             | Who has it by default   | What it allows                                                         |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `realestate.use`       | Owners, admins, members | Work on the deals they're on                                           |
| `realestate.all_deals` | Owners, admins          | See every deal                                                         |
| `realestate.except`    | Owners, admins          | Complete a duty without its proof, waive one, set the final commission |
| `realestate.manage`    | Owners, admins          | The duty editor and the add-on's settings                              |

Each can be given or taken per role and per person in Settings → Permissions.

## Screens

Drawn first in `design/realestate`, then built on the web under `/app/w/<business>/a/realestate/`:

- **Deals:** health counts, My deals and All deals, Needs attention, dates to confirm and conflicts; Start a
  buyer deal and Start a listing.
- **A deal:** its stage and the next move, its health and reasons, the people on it and their roles, clients and
  parties, the property, key dates and terms with their source and history, duties by phase with their due time
  and proof, documents with versions and locks, commission, client updates, and its history.
- **A duty:** its status, what finishes it, proof added, what's missing, exception and waive, moving the due
  date with a reason, and its history.
- **My duties:** today, waiting on someone, blocked, dates to confirm.
- **Settings → Real estate:** the duty editor and its versions, the alert person, reminder days, closed days,
  milestone drafts.
- **Panels** on a customer, a company, a Pipeline lead and a property: their deals, and Start a deal.
- **Home** shows add-on alert cards; Settings → Account gets the Add-on alerts push switch; support access sits
  on the deal and in Settings → Real estate.

## Build order

Each step is its own commits ("Real Estate step N: …"), with CI green before the next. Each migration goes on
the hosted database before its step reaches `main`, numbered above the hosted database's newest version.

### Step 1 — The plan and the boards

This document, and the boards in `design/realestate`. Chris reviews the boards before Step 11.

### Step 2 — Staff hand out a test add-on (built, 2026-09-30)

1. Migration: `platform.addon_grants` and its policies.
2. Core: grants in the capability sets, `addon_grant.give` and `addon_grant.take_back`, the Testing badge.
3. Web: "Add-ons in testing" on the admin page for a business.
4. Tests: a granted add-on is installable there and nowhere else; only staff write grants.

**As built:**

- `platform.addon_grants` and `private.give_addon_grant` / `private.take_back_addon_grant`
  (`20261013002200`); `addon_grant.give` and `addon_grant.take_back` (`packages/core/src/commands/addon-grant.ts`).
- A grant can hand out an add-on in `development`, `beta` or `built`, and an `available` paid one (so staff can
  hand out a paid add-on before billing exists). Never a planned, deprecated or switched-off one
  (`addon_not_grantable`).
- A granted add-on is installable there (`installableHere`, `grantedHere`) and listed under Available to add with a
  Testing badge, on the web and the phone (`addon.list`'s `catalog[].testing`). It is never suggested, on Home or
  by the Assistant (`recommendAddons` still names only available, free ones).
- `/admin/businesses/<id>` has "Add-ons in testing" for staff with `platform.addons.manage`.

### Step 3 — Signed files are kept (built, 2026-09-30)

1. Migration: the lock and fingerprint columns on `app.files` and their guard.
2. Core: `file.lock`, the `file_locked` refusal on `file.delete`, the lock in `file.list`.
3. Worker: the SHA-256 of every file that arrives.
4. Web: "Signed · kept" and no Delete on a locked file.
5. Tests: nobody deletes or unlocks a locked file; deleting the business still does.

**As built:**

- `20261013002300`: the lock and fingerprint columns and `private.guard_locked_file`, which also refuses a person
  setting a lock or a fingerprint as a file is added, and any fingerprint but the worker's first.
- `file.lock` (risk 2, people and the system; `records.write`) writes a `file_locked` timeline line. Files that
  belong to the business (knowledge, number papers) aren't locked (`file_not_lockable`).
- The worker fingerprints on `file.attached` and again on `file.locked` if it had to wait
  (`apps/worker/src/handlers/file-fingerprint.ts`).
- `file.list` and the phone's synced files say `locked`; the web shows "Signed · kept" and no Remove. The phone
  has no Remove for record files, so nothing changes there.

### Step 4 — Records kept to the people on them (built, 2026-09-30)

1. Migration: the private-kind and owner-and-team columns, `sealed` on what hangs off a record, the visibility
   helpers, every policy and Storage rule, `addon_table_policies` with a record column, and support grants.
2. Core: `keptToTeam` in the manifest, `custom_record.assign` and `custom_record.unassign`, support-access
   commands.
3. Worker: the add-on's kinds seeded with their privacy; the morning digest and customer notes skip sealed rows.
4. The one change to `apps/sync/sync-config.yaml`, run through `sync.yml` on the branch.
5. Tests in `packages/db/test`: the owner, an admin, the main agent, a teammate, a member not on it, a See-every
   holder, support with and without access, and the founder, across every table that follows the record.

**As built:**

- `20261013002400`. Visibility is `private.custom_record_visible` (the caller), `private.user_sees_record`
  (someone else, for the worker and support grants) and `private.private_kinds_seen_whole` (the kinds whose
  see-all permission the caller holds). The record's own policies ask it inline.
- Home cards use one restrictive policy (`attention_items_sealed`) instead of changing both select arms, so the
  inbox's parity check (`private.sync_inbox_mismatches`) still compares the members' arm with
  `member_viewer_ids`. A card about a task takes the task's record.
- A relationship line about a private record is sealed with it when both ends share the line (a customer and a
  deal); when each end has its own line (a deal and a property), the shared end gets none.
- Support: `private.request_support_access`, `grant_support_access`, `decline_support_access`,
  `end_support_access`; `support_access.request` (platform, `platform.view_as`), `.grant`, `.decline`, `.end`,
  and `support_access.list`. Owners and admins, and the main person on any private record, are emailed; they
  answer on **Settings → Support access** (`/settings/support-access`). Staff ask from `/admin/businesses/<id>`.
- The web's record page shows **On this deal** (the customer's Assigned card, taught private records) for a
  private kind; the morning email leaves out cards about a record its reader can't see.
- The phone's streams: `sealed = false` on tasks, activities, files and attention items (both arms), and files add
  `locked_at`, recorded in the mobile contract; `node scripts/mobile-schema.mjs`.

### Step 5 — Add-on alerts (built, 2026-09-30)

1. Migration: `app.addon_alerts`, the `addon_alert` kind, the push switch.
2. Core: the kind in every list that names kinds, the push category.
3. Worker: raising, clearing and acknowledging an alert; push and email once each; working hours; clearing on
   turning off; `addon_verify` and purge.
4. Web and phone: the card and the switch.

**As built:**

- `20261013002500`. Only the worker writes `app.addon_alerts`, and only while the add-on may write there; people
  read the alerts they see (`private.addon_alert_visible`: the add-on runs, they hold its permission, they're in its
  audience when it names one, they see its record). Home cards follow the same rule through one restrictive policy
  (`attention_items_addon`), and a card takes its alert's record, so a private deal seals it too.
- `raiseAddonAlert` / `clearAddonAlert` in `apps/worker/src/addons/alerts.ts`. The same key is the same alert; what
  it says (severity, words, due time, `needsAck`) is its fingerprint, and a new fingerprint is news: a snoozed card
  comes back, an acknowledgement is asked for again, and `addon_alert.notify` tells people once (marked on the row,
  so a retry never tells them twice). Critical at any hour, the rest once the business is open (its open hours);
  `info` stays on Home. Push switch `addons`, email switch `addonEmail` ("An add-on needs you"), both on unless
  turned off, on the web's and the phone's settings and in the Assistant's.
- Home: `critical` and `at_risk` are urgent at once, `attention` at its due time, `info` never; severity sets the
  rank. The card is named after the add-on, opens the add-on's page (`/a/<id>/…`), and offers **Acknowledge** in
  Let HandsFreeOS Handle's place when the alert asks for it. It can be snoozed, not dismissed, assigned or handed
  off: it goes when the add-on clears it (`done` counts as handled today). `addon_alert.acknowledge` (risk 1) is the
  command; its event reaches only the add-on whose alert it was.
- Left out of the morning and evening emails (alerts send their own), and off phones: both attention streams add
  `kind != 'addon_alert'`, and the phone opens any `/a/…` page on the web.
- Turning an add-on off clears its alerts and resolves their cards (`addon_off`) in `private.addon_cancel_work`;
  `addon_verify` checks `no_alerts_showing`, and after a purge `no_alerts_left`.

### Step 6 — The add-on's shell

1. `pnpm addon:new realestate` and its manifest: permissions, kinds, relationship types, events, jobs, settings,
   menu places and panels.
2. The deal tables: `deals`, `deal_roles`, `deal_links`, `deal_history`.
3. Core glue: the lead page's panel place, add-on timeline lines, AI use counted under an add-on.

### Step 7 — The catalog and the dates

The 148 rows and 24 trackers, business days and holidays, due rules, conflict checks and the state machines, all
pure and tested.

### Step 8 — Deals, terms and the duty list

Terms, template versions, duties, their links, proof, log and documents tables; opening and moving deals,
entering and confirming terms, creating duties, commission, the editor's commands, and the queries.

### Step 9 — Duties and documents

Every duty move with the proof rule, exceptions, waiving, due overrides; documents, versions and locking; wire
changes. Tests follow the specification's acceptance scenarios (§22).

### Step 10 — Health and alerts

Health with its reasons, the sweep, the ladder, working hours, and turning off and on.

### Step 11 — Screens

Deals, a deal, a duty, My duties, and the panels, from the approved boards; a browser test from a staff grant to a
refused and then accepted proof.

### Step 12 — Settings

The duty editor, publishing and applying a version, the alert person, reminder days and closed days.

### Step 13 — AI

The Assistant's tools, client update drafts, the fair-housing check, and sending.

### Step 14 — Beta

`beta`, `docs/realestate.md` with its rules, the add-on architecture doc brought up to date, how staff hand out a
test add-on in `docs/operations.md`, and a row in CLAUDE.md.

## Not in this round

- The buyer and listing workspaces: search, buyer memory, tours, comparisons, offers and counters, marketing,
  open houses.
- Reading contracts and reports; the MLS, e-sign, lender, title, insurance and showing connectors (each needs
  an add-on's own credentials and webhook routes in core first).
- The client portal, and phone screens for deals.
- The AI teammate using the add-on, and workflow steps and triggers from it.
- State rules, a brokerage rule engine beyond the duty editor, retention and legal holds, and exporting a whole
  transaction.
- Prices for add-ons.
