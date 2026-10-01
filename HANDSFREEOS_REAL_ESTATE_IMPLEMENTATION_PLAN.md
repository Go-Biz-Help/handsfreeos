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

**Where it stands (2026-09-30):** round one is built, and the add-on is in `beta`: HandsFreeOS staff hand it to test
businesses. `docs/realestate.md` is the guide for working on it. Its migrations, `20261013002200` to
`20261013003000`, are on the hosted database. Round two (the buyer's side and the client portal) is being built on
the same branch; Chris wants the whole add-on done before it goes to `main` in one pull request (see "Round two"
below).

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
- A phone push about a deal opens the deal on the phone. Chris (2026-09-30): "we will have phone deal screens, so
  prepare and code like they will exist." The manifest names the deal pages the phone draws (`ui.phone`), and a push
  carries the deal as `refs.recordId`. Until the phone has the screens (a later round), the link opens the web.

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

### Step 6 — The add-on's shell (built, 2026-09-30)

1. `pnpm addon:new realestate` and its manifest: permissions, kinds, relationship types, events, jobs, settings,
   menu places and panels.
2. The deal tables: `deals`, `deal_roles`, `deal_links`, `deal_history`.
3. Core glue: the lead page's panel place, add-on timeline lines, AI use counted under an add-on.

**As built:**

- The manifest (`packages/core/src/addons/realestate/manifest.ts`), still `development`: permissions
  `realestate.use` (admins and members), `.all_deals`, `.except` (which also sets the final commission) and
  `.manage` (admins). Kinds `realestate_deal` (icon `key`, kept to its people, seen whole with `.all_deals`) and
  `realestate_property` (shared). Relationship types: deal → property (each deal one property), and client, loan
  officer, other side's agent, title or escrow contact, inspector, vendor and attorney (people), lender, title or
  escrow company, other side's brokerage and vendor (companies), each labelled "Deal (…)" from the other end. One
  menu place, **Deals**. Events, jobs, settings and panels arrive with the steps that use them.
- `20261013002600`: its four permissions, and its tables in `addon_realestate`, each following its deal's privacy
  (`addon_table_policies` with the record column). `deals` is keyed by the deal's record (and must be one of its
  deal records); `deal_roles` (agent, co-agent, coordinator, assistant) only for someone on the deal; `deal_links`
  (`same_home`, `sale_and_purchase`) a row each way, never across businesses (composite keys); `deal_history`
  append-only. Mirrored in
  `packages/core/src/addons/realestate/tables.ts`, held to the live columns by its own test.
- `20261013002700` (core): `addon_line` timeline lines (`addonTimelineLine`), redacted by the purge and checked by
  `addon_verify`; `app.ai_usage` source `addon` with `addon_id`. The lead page has a panel place, `lead.panels`.
- Choice made for Chris (labels can change any time): the "Deal (…)" labels.

### Step 7 — The catalog and the dates (built, 2026-09-30)

The 148 rows and 24 trackers, business days and holidays, due rules, conflict checks and the state machines, all
pure and tested.

**As built** (`packages/core/src/addons/realestate/`):

- `catalog/`: every row of §13–§15 in order, with the specification's own words (title, phase, behaviour, owner,
  mode, share) beside what the add-on needs: what creates it (entering a stage, a key date confirmed, or a named
  moment such as an offer lost or a repair request), facts it depends on (financed, HOA, well, septic, solar,
  open houses, a backup offer, and the rest), when it's due, what finishes it, who answers for it (agent,
  coordinator or brokerage) and who does the work, its automation level and how much it matters. The 24 trackers
  of §16 carry the defaults. A row on both sides can start at a different stage on each. `CATALOG_VERSION` 1.
- `dates/`: federal holidays as observed (`us-federal-1`), business days with a business's own closed days, due
  times with a replayable trace, and nine checks across a deal's dates.
- `states.ts`: the two sides' stages, the named moves back, duty statuses and their moves.
- Tests: the catalog (148 ids in order, all 24 trackers, sides, stages, dates and documents real), holidays for
  2026 to 2028, business days, due times across a clock change, and the checks.

**Defaults chosen for Chris** (each one a setting in the duty editor, step 12; say the word and they change):

- Deadlines the specification leaves open: a seller lead answered within an hour; an offer logged within two
  hours and read within four; CMAs within a business day; the buyer agreement within two business days of the
  representation stage; inspections booked by three days after acceptance or four before the inspection period
  ends, whichever comes first; the seller's disclosures three days before the listing goes live; photos five days
  before; walkthrough access two days before closing; insurance ten days before closing; seller updates and
  feedback reviews weekly; a price review every two weeks while active; post-close check-ins every 90 days and a
  home anniversary each year.
- Buyer offers: the first offer's CMA and offer (B-10, B-11) come with the first pass through Offer; B-15 and B-16
  ("another CMA", "another offer") with each later one. An offer lost takes the deal back to Touring, a buyer's
  terminated contract to Searching, a listing's to Active.
- Ongoing rows (MLS searches, showing management, the contingency tracker, fair-housing guardrails and the like)
  have no single deadline and no proof; they're kept up while the deal is in their stages.
- Earnest money is tracked on listings (S-51) as the specification lists it; on buyer deals it's part of building
  the contract's dates (X-15), which needs acceptance, earnest money and closing entered.
- X-27 is the wire-fraud warning at contract (never automatic); the separate "wiring instructions changed" duty
  with its phone check comes with step 9's `deal.report_wire_change`.
- The Closing Disclosure check counts business days the same way as everything else (Monday to Friday, less
  holidays), which is a day or so stricter than the federal rule that counts Saturdays.

### Step 8 — Deals, terms and the duty list (built, 2026-09-30)

Terms, template versions, duties, their links, proof, log and documents tables; opening and moving deals,
entering and confirming terms, creating duties, commission, and the queries. The editor's commands moved to
step 12, beside its screen.

**As built:**

- `20261013002800`: `deals` gains its facts, its duty list's version and the catalog's version. New tables, each
  following its deal's privacy: `term_entries` (append-only apart from being confirmed, replaced or set aside,
  once each), `template_sets` and `template_items` (a published list, never changed), `template_overrides` and
  `custom_templates` (the editor's drafts, `realestate.manage`), `duties` (with its due time, the trace behind it,
  the dates it still needs, and whoever answers for it, who must be on the deal), `duty_links`, `documents` (a
  deal's own file, with its lineage and status), `duty_evidence` and `duty_log` (append-only). Mirrored in
  `tables.ts`.
- Browser-safe: `terms.ts` (the key dates plus price, list price, earnest money, loan amount, seller credit, loan
  type and who holds the earnest money; a term as it stands, its conflicts, the key dates it gives), `commission.ts`
  (gross from a rate of the price or a flat amount, less the credit, and the agent's share), `schemas.ts` and
  `words.ts`.
- The duty engine (`ops/engine.ts`): a stage entered or passed, a key date confirmed, or a named moment creates the
  duties of the deal's list for it whose facts hold. One is made again only when every earlier one is finished; a
  date's duties once per contract. A duty resting on a contract date is a draft until those dates are confirmed.
  Every change re-works the due times of open duties (unless set by hand), turns ready drafts active and
  re-works the expected commission; each is a line in `duty_log`.
- Commands (`realestate.use` unless said): `deal.open` (from a lead or a customer, a property found or new, its main
  agent someone else only for owners and admins), `deal.move_stage` (forward only; past Closing only once closed),
  `deal.record_event` (an offer in, the inspection report, a repair request, repairs agreed, a low appraisal, an
  amendment, a changed search), `deal.record_offer_lost` and `deal.terminate` (back to Touring, Searching or
  Active; the offer's or contract's terms and unfinished duties set aside, kept in history), `deal.close` (from
  Closing; "Mark the lead won too"), `deal.end` and `deal.reopen`, `deal.set_facts`, `deal.add_person`,
  `remove_person` and `set_role` (duties follow the coordinator and main agent), `deal.set_property`,
  `deal.link` and `unlink`, `party.add` and `remove`, `deal.set_commission`, `deal.set_final_commission`
  (`realestate.except`), `deal.archive` and `restore` (owners and admins), and `term.enter`, `confirm`, `reject`
  and `resolve_conflict`. Queries: `realestate.overview`, `deal.list`, `deal.get` (with the checks across its
  dates), `deal.history`, `term.history` and `deal.for` (a customer's, company's, lead's or property's deals).
- Tests: `test/addons/realestate-deals.test.ts` (21 cases on the database: privacy, stage jumps, drafts,
  conflicts, amendments, termination, a lost offer's later round, facts, the team, links, closing, ending,
  archiving).

**Choices made for Chris** (say the word and they change):

- Entering a date saves it confirmed, since a person typed it; "leave it for someone to check" saves it
  unconfirmed. A date that disagrees with one already there is kept beside it until someone chooses.
- A lost offer or a terminated contract sets the old terms aside (they stay in history), so the next contract's
  dates start fresh and bring their own duties.
- Closing needs the deal at the Closing stage first. After it closes, a buyer deal is at Possession and a listing
  at Sold.
- A buyer deal under contract ends only by terminating the contract first; a listing under contract the same.
- Taking a fact off cancels only the duties nobody has started.
- Archiving a deal takes core's archive permission (owners and admins by default).

### Step 9 — Duties and documents (built, 2026-09-30)

Every duty move with the proof rule, exceptions, waiving, due overrides; documents, versions and locking; wire
changes. Tests follow the specification's acceptance scenarios (§22).

**As built:**

- `proof.ts` (browser-safe): whether a rule's items are met by the proof on a duty and what the deal holds
  (confirmed dates, the commission, its property and client), and what's missing in words ("a signed Purchase
  contract and contract accepted confirmed"), the same words the refusal and the duty drawer use.
- `own-duties.ts`: duties that aren't catalog rows. `W-00` is the wire check (critical, never automatic, finished
  only with the person's own word that they called at a number they found themselves, and a note); `W-01` onwards
  are duties a person writes on one deal.
- Commands (`realestate.use` unless said): `duty.set_status` (not started, in progress, waiting on someone, blocked
  with what, whose, the impact and when to look again; the due date never moves for it), `duty.add_evidence` (a
  document or file of the deal's, a note, an attestation, an appointment, a message) and `withdraw_evidence`,
  `duty.assign` (only to someone on the deal, or the brokerage), `duty.acknowledge`, `duty.complete` (refused with
  `duty_needs_proof`, saying what's missing), `duty.complete_with_exception` and `duty.waive` (`realestate.except`,
  with a reason), `duty.cancel`, `duty.reopen`, `duty.set_due` (by hand, with why, or back to its rule),
  `duty.add`; `document.add` (a file already on the deal, as a new line or the next version), `document.update`,
  `document.mark_signed` (locks its file through core's `file.lock`, replaces earlier versions, and makes it the
  one that counts unless another does), `document.set_controlling`, `document.void`; and
  `deal.report_wire_change`. Queries: `duty.get` (with its proof, what's missing, its evidence and log),
  `duty.list` (My duties), `document.list`; `deal.get` now says what each duty still lacks.
- The worker half (`apps/worker/src/addons/realestate/`) hears its own events: a reported wire change raises a
  critical alert at once (step 5's alerts, acknowledged by a person), and the check being done, waived or cancelled
  clears it.
- Core: `@hfos/core/addons/*` exports an add-on's core code to its worker and web halves; the boundary test now
  checks those imports too, so one add-on still can't reach another's.
- Tests: `test/addons/realestate-duties.test.ts` (a human-only duty, the evidence rule and its exception, a blocked
  item, drafts, signed and versioned documents, an amendment's signed source, a changed wire, a duty written on a
  deal) and `apps/worker/test/realestate-wire.test.ts`.

**Choices made for Chris** (say the word and they change):

- Only a person gives their word on a duty: the Assistant can't attest for them (spec §22, "it never claims to
  have attended").
- An owner's exception is recorded as one only when proof was actually missing.
- A second wire-change report while a check is open joins it rather than starting another. Ending a deal leaves an
  open wire check open.
- A duty set by hand on a weekend or holiday keeps its date and shows the warning, as a calendar-day rule does.
- Proof can't be added to or taken from a finished duty; reopen it first.

### Step 10 — Health and alerts (built, 2026-09-30)

Health with its reasons, the sweep, the ladder, working hours, and turning off and on.

**As built:**

- `health.ts` (browser-safe): green, yellow or red with every reason, each with what's wrong, the next step, and the
  duty, dates, due time and person it's about, by the rules under "Health and alerts" above. Every command that
  changes a deal works it out again and keeps it on the deal (`deals.health`, `health_reasons`), with a line in the
  deal's history when its colour changes.
- `ladder.ts` (browser-safe): a Home card from seven days out; a push three days and one day out (and an email for
  material work); at risk once overdue, to the person answering for it; a business day late, at risk and asking to
  be acknowledged, to them, the main agent and the coordinator; critical for a critical duty once overdue or a
  material one two business days late, to everyone who sees the deal, at any hour. Late counts business days, so
  a weekend or holiday doesn't make a duty late.
- `realestate.sweep`, the add-on's own system command, works each open deal out again (and closed ones with duties
  left) and answers where each open duty is on the ladder. The worker's `realestate.sweep` job runs it every 15
  minutes and raises one alert per duty (`duty:<id>`) that climbs as it goes, clearing the rest. Turning the add-on
  on arms it from then: a rung reached while it was off becomes a Home card only. Turning it off cancels the job
  and clears its alerts (step 5). An acknowledged alert stops climbing; acknowledging the duty acknowledges its
  card, and finishing the duty clears it at once.
- `realestate.deal.risks`: "what could stop this closing?", with every reason and each open material or critical
  duty, who answers for it, when it's due, the proof it still needs and the next step.
- Core (step 5's alerts): an alert can push without emailing (`email: false`), so the ladder's reminders for
  everyday work don't fill inboxes.
- Tests: `test/addons/realestate-health.test.ts` (every rule, the ladder, holidays), the wire case's health in
  `realestate-duties.test.ts`, and `apps/worker/test/realestate-sweep.test.ts` (each rung, critical at any hour,
  the quiet catch-up, acknowledging, clearing).

**Choices made for Chris** (say the word and they change):

- "A late reply" isn't a reason yet: HandsFreeOS doesn't know which messages a deal is waiting on. It comes with
  the client updates (step 13).
- Critical alerts go to the deal's team and the business's alert person (its owners until it picks someone, step
  12). A changed wire's alert goes to everyone who sees the deal.
- An alert acknowledged on Home stops climbing; it still goes when the duty is done.

### Step 11 — Screens (built, 2026-09-30)

Deals, a deal, a duty, My duties, and the panels, from the approved boards; a browser test from a staff grant to a
refused and then accepted proof.

**As built:**

- Chris approved the boards on 2026-09-30 ("build it").
- Pages under `/app/w/<business>/a/realestate/`, each through the gate: Deals (`page.tsx`: health counts, My deals,
  All deals, Needs attention, Closed, Archived, a search, Start a buyer deal and Start a listing), a deal
  (`deals/<id>`: its stages, the next move or Close, what could stop the closing, duties grouped by what brought
  them, key dates, people, commission, client updates; a duty opens in the drawer at `?duty=<id>`, where every
  alert about the deal lands), Key dates (`deals/<id>/dates`: every value with its source and history, confirm,
  change, and a conflict settled only by a person with a reason), Documents (`deals/<id>/documents`: versions, the
  one that counts, Mark signed, and files on the deal not filed yet), History (`deals/<id>/history`) and My duties
  (`duties`: overdue, today, this week, later, waiting, blocked, and waiting for a date; Everyone's for people who
  see every deal).
- The duty drawer: what finishes it and what's missing, a note, someone's word, a file or a document as proof, taking
  proof back, waiting on and blocked, marking done (refused without its proof), done with a reason or waived for
  owners and admins, moving the due date with a reason, handing it over, acknowledging, cancelling, reopening, and
  its history.
- Panels (`<AddonSlot>`): a customer's, a company's, a lead's and a property's deals with Start a buyer deal and
  Start a listing filled in from the page; on a deal's plain record page, the way to its page. Closing a deal from a
  lead asks "Mark the lead won on the Pipeline too".
- Menu places: Deals, My duties, and Deal settings (owners and admins). The Add-ons page's sheet points to Deal
  settings.
- Core, browser-safe, for the phone and the Assistant later: `rule-words.ts` (a due rule, proof, what brings a duty,
  reminders, "due Fri", "2 days overdue", how a due date was worked out) and `history-words.ts` (a deal's and a
  duty's history in sentences). `realestate.property.search` finds a property already here by its address; the deal
  list says each deal's first problem, its dates to confirm and whether the person is on it; a deal's duties say
  what finishes them and who they wait on; a duty says its due rule in words.

**Choices made for Chris** (say the word and they change):

- A customer's panel shows only the deals the person sees. The board's "1 more deal you're not on" line is left out:
  counting deals a person can't see needs a database change, and it tells them something about a private deal.

### Step 12 — Settings (server built, 2026-09-30; screens wait for the boards)

The duty editor, publishing and applying a version, the alert person, reminder days and closed days.

**As built (server):**

- The add-on's settings (`settings.ts`, saved through core's `addon.save_settings` with `realestate.manage`): the
  alert person (owners or people who see every deal; none picked means the owners), the business's closed days,
  and which milestones get a drafted client update (step 13). Closed days count as days off in every business-day
  rule and warning.
- `editor.ts` (browser-safe): the rules as schemas (due rules, proof, what brings a duty), what a business may
  change about a catalog row, its own duties, the list a version keeps, and how two versions of a duty differ in
  words.
- Commands (`realestate.manage`): `template.set_override` and `clear_override` (on or off, timing, reminders, who
  answers, proof, how much it matters), `template.save_custom` and `archive_custom` (the business's own, `C-01`
  onwards, held to the catalog's checks), `template.publish` (a new version from the drafts; refused when nothing
  changed), and `deal.apply_template_version` (moves an open deal to a version: duties turned off are cancelled,
  changed ones take the new timing and proof, and ones it adds for what already happened are created). Queries:
  `template.list` (the drafts, what each changes, the published version and whether drafts differ),
  `template.versions` (with how many open deals follow each) and `template.diff` (the preview of applying one).
- New deals take the newest published version; open deals keep theirs.
- Reminder days: each duty's own (its tracker's, or the editor's) decide its early cards on the ladder; once due,
  every duty climbs the same. Duties written on a deal remind at 7, 3 and 1 days.
- Critical alerts now go to the deal's team and the business's alert person.
- Tests: `test/addons/realestate-editor.test.ts`.

**As built (screens, 2026-09-30):**

- Deal settings (`/a/realestate/settings`, a menu place for owners and admins), with four tabs. **Duty list**: every
  duty with when it's due, its proof and who answers for it in words, filtered by side, the business's own, changed
  and turned off; a duty's editor (on or off, when it's due, what finishes it, who answers, how much it matters,
  its reminders, and back to how the list has it); Write a duty; Publish version N (with a note). **Alerts &
  dates**: the alert person (owners and people who see every deal), closed days, and the four milestone drafts,
  each saved at once. **Versions**: every version with how many open deals follow it. **Support access**: core's
  support-access card.
- "Apply the newest duty list" on a deal's More menu shows what would be cancelled, changed and added before it
  moves the deal.

**Choices made for Chris** (say the word and they change):

- Reminder days are each duty's own, set in the duty editor; the Alerts & dates tab explains that rather than
  having one business-wide setting (board 9 showed one box).
- Federal holidays are always skipped; the tab says so rather than offering a switch.

### Step 13 — AI (server built, 2026-09-30; screens wait for the boards)

The Assistant's tools, client update drafts, the fair-housing check, and sending.

**As built (server):**

- The Assistant's tools, only while the add-on is on and the person holds `realestate.use`, and only over the deals
  they see. On its own: find deals, read a deal, "what could stop this closing?", list duties, read a duty, list
  documents, a date's history, read a client update, and draft one (drafting sends nothing). With the person's OK:
  open a deal, move it, record a moment, set its facts, enter or confirm a date, update a duty, add proof (never
  the person's word for them), complete a duty, add one, report a changed wire, and send a client update. Never
  offered: exceptions, waiving, terminating or ending a deal, archiving, the final commission, the team, and the
  duty editor.
- `20261013002900`: `drafts` (one client update, requested to sent or discarded, with the facts the model was given
  and the model) and `fair_housing_checks` (every check of every version of its words, append-only, with a digest
  of the exact text read).
- `fair-housing.ts`: the fixed list (`fh-words-1`): phrases by protected class and the steering proxies, each with
  why and a safer way to say it. `prompts.ts`: the drafting and checking prompts, the deal's facts quoted as data
  (the address, stage, confirmed dates, what's done and next, the agent's name, the client's first name; never
  notes).
- Commands: `status_email.request` (asked for, or at a milestone), `save` (the agent's edits: the list checks at
  once, the model a moment later, and an earlier confirmation no longer counts), `acknowledge_flags` (with a
  reason), `send` (refused while a check is running or flags are neither fixed nor confirmed; through core's
  `message.send` to the client, from the agent's own mailbox, else their own address, else the team inbox) and
  `discard`; the worker's own `drafted` and `checked`. Queries: `status_email.list` and `get` (flags on the words
  as they are now, and whether it can be sent).
- The worker drafts with the model (counted as the add-on's AI use), runs both checks, offers a draft at each
  milestone the business keeps on (under contract, the inspection report in, clear to close, closed) with a card on
  the main agent's Home, and clears it when sent or thrown away. A model that can't be asked leaves the fixed
  list's check, marked so.
- Tests: `test/addons/realestate-updates.test.ts` and `apps/worker/test/realestate-updates.test.ts`.
- `20261013003000` (core, fixing step 4): an add-on table that follows a private record now asks once per query
  which private records the person can't see (`private.unseen_private_records()`) and which support may read
  (`private.support_seen_records()`), instead of asking for every row. An owner's whole Deals list went from timing
  out under load to under a second; who sees what is unchanged (the private-records and add-on tests).
- To look at later: a deal command takes 0.5 to 1.4 seconds on the local stack (opening a listing at Active makes
  45 duties). Fine for now; the engine's many small writes are where to start.

**As built (screens, 2026-09-30):**

- A client update's page (`/a/realestate/deals/<id>/updates/<draft>`): the subject and message to check and edit,
  the fair-housing flags with why and a safer way to say it (clicking one selects its words), Keep it with a reason,
  what the AI saw, Save changes (read again), Send once it's clear, and Discard. It looks again every few seconds
  while the AI is writing or reading.
- The deal page's Client updates card lists them and drafts one on request. Alerts now open what they're about: a
  duty's in its drawer (`?duty=<id>`), a draft on its own page.

**Choices made for Chris** (say the word and they change):

- The board's "Use the suggestion" isn't there: the safer wording is advice ("describe the home itself"), not words
  to swap in. The flag selects its words so the agent can rewrite them, or keep them with a reason.
- "Clear to close" is the deal reaching the Closing stage, and "inspection done" is the inspection report being
  recorded.
- A draft for a milestone comes once; asking again makes a new one.
- When the model can't be reached, the update can still go after the fixed list's check.

### Step 14 — Beta (built, 2026-09-30)

`beta`, `docs/realestate.md` with its rules, the add-on architecture doc brought up to date, how staff hand out a
test add-on in `docs/operations.md`, and a row in CLAUDE.md.

**As built:**

- The manifest's status is `beta`: offered to nobody on its own, and Coming soon for everyone else as before.
- `docs/realestate.md`: where everything is, the screens, the rules worth knowing, handing it to a test business,
  working on it, and what's not built yet. `docs/addon-architecture.md` now covers grants and locked files, points to
  it, and says a beta add-on is offered only where staff handed it out. `docs/operations.md` has "Hand an add-on to
  a test business" under Add-on votes. CLAUDE.md's Read first table has a row for it.
- The browser test (`apps/web/e2e/realestate.spec.ts`): staff hand it to a business (a worker test route,
  `/test/staff/make-admin`, makes the test's owner staff), the owner installs it, starts a buyer deal at Touring, a
  duty that needs a note is refused and then finished with one, and a member off the deal never sees it.

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

# Round two: Buyer core

The spec's **Buyer core** release (§23): the buyer's agreement, financing, finding homes and what the buyer wants,
tours, the CMA and offers, inspections and closing, and a portal for the client. Chris decided every question below
on 2026-09-30, after watching round one's walkthrough. The later rounds follow in the same branch: Listing core,
Coordinator and risk, Ecosystem (the connectors), then the phone and the finish.

## Decisions (Chris, 2026-09-30)

| Question                            | Answer                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Homes before the MLS                | **The agent and the client add them.** The agent pastes an address or a listing's text; the AI fills in the facts and the agent confirms them. The client adds homes from the portal. The MLS fills them in once it's connected.                 |
| A pasted listing link               | **Kept, never read.** Listing sites forbid automated reading. The agent pastes the listing's text.                                                                                                                                               |
| Tours                               | **On the calendar.** One appointment per tour on the agent's calendar, with the homes in order; the client is invited and reminded. Someone off a private deal sees the tour only as busy.                                                       |
| A tour without a signed agreement   | **Refused**, unless an owner or admin (Approve exceptions) lets it through with a reason, which is kept.                                                                                                                                         |
| Offers                              | **Terms here, the contract elsewhere.** Every version and counter is kept, the response deadline is watched, and the client gets a one-page summary. The state contract is filled in the agent's forms software and uploaded.                    |
| Buyer memory                        | **The AI suggests, the agent confirms.** Wants and must-haves from the client's messages and call notes, each with the words it came from. Nothing counts until the agent confirms it. Anything about who lives there is never kept.             |
| The financing tracker               | **The agent and coordinator mark each step**, with proof: preapproval, application, rate lock, appraisal, conditional approval, clear to close, the Closing Disclosure, funding. The lender connector comes later.                               |
| The CMA                             | **The agent adds comps**; HandsFreeOS works out a price range and the AI drafts the summary for the agent to check. The MLS fills in comps later.                                                                                                |
| How a client gets into the portal   | **A private link and an emailed code.** On a new device the client types a 6-digit code sent to the email on file. No password.                                                                                                                  |
| The portal and the planned add-on   | **Shared sign-in, own portal.** Core builds what every portal needs (the link and code, client uploads, portal messages); Real Estate's portal shows only the client's deals; the planned Customer Portal add-on comes later on the same pieces. |
| What the client can do              | **See where things stand** and the key dates, **do their own tasks** (upload a preapproval or ID, sign off), **save or pass on homes** and leave feedback after a tour, and **message the agent**.                                               |
| Who sees a client's portal messages | **The people on that client's deals**, and owners, admins and anyone with See every deal.                                                                                                                                                        |
| The "your agent replied" email      | **A link only.** The words stay in the portal.                                                                                                                                                                                                   |
| Phone screens                       | **Coded as if they exist.** Links to a deal's pages open the phone's own screen once it has one, the web until then (the manifest's `ui.phone`).                                                                                                 |

Chosen for Chris, open to change:

- A device stays signed in to the portal for 30 days after it was last used, and 90 at most.
- Two clients on one deal each get their own link and sign-in, and each one's save or pass is their own.
- A private deal's appointments show to others as busy: round one decided it, but made no appointments, so core
  builds it now (step 1).

## How it works

- **Core first.** Five pieces any add-on (and the later Customer Portal) can use: private records' appointments shown
  as busy; the portal's sign-in (a link per client, a code by email, a session per device); a customer who is signed
  in (a new kind of actor, allowed only operations that say so, reading under row security); client uploads through
  the worker; and portal messages in the Inbox (a new channel, `portal`).
- **The buyer's side** keeps its own records in `addon_realestate`, each following its deal's privacy: the buyer's
  profile and memory, homes and the client's reactions, tours and their stops and feedback, CMAs and comps, offers and
  their versions, financing steps, inspections, findings and repair requests, and the client's tasks. Each one adds
  proof to the catalog duties it answers; none finishes a duty on its own.
- **The AI** fills a home's facts from pasted text, suggests buyer memory from what the client said, and drafts the
  CMA's summary. Every fact and every quote must appear in the words it read; the agent confirms each one; the fair
  housing checks read every summary and every suggestion.

## Build order (round two)

Round two's migrations start at `20261014000100`, leaving room for work on `main` above the hosted database's
`20261013003000`. Screens wait for Chris to approve the boards; the server steps go ahead meanwhile.

- **Step 0:** this part, and the boards in `design/realestate` (numbers 13 to 31).
- **Steps 1–5 (core):** busy-only appointments on private records; the portal's sign-in; the customer actor and
  add-ons' portal pages; client uploads; portal messages in the Inbox.
- **Steps 6–13 (Real Estate):** homes and the buyer's profile; buyer memory; tours and the agreement rule; the CMA;
  offers and counters; financing, inspections and closing; client tasks and the portal's operations; duty hooks.
- **Step 14:** the staff screens. **Step 15:** the portal's screens, the Assistant's tools, the docs, the browser
  test and a short video.

### Step 1: a private record's appointments show only as busy (built, 2026-10-01)

**As built** (`20261014000100_private_appointments_show_busy.sql`):

- `app.appointments.sealed` and `app.appointment_attendees.sealed`, kept by triggers from the record's privacy, like
  tasks and files. Their policies add "not sealed, or the caller sees the record", asked once per query
  (`private.unseen_private_records()`, `private.unseen_sealed_appointments()`).
- Who works an appointment and when (`appointment_staff`, `appointment_resources`) stays visible: it says nothing
  about the deal. Availability reads it with a left join, so a hidden tour still blocks its people's time, and a
  booking over it is refused as `slot_taken`.
- `private.private_busy()` gives `schedule.team` each person's `privateBusy` times: only for the appointments the
  caller can't open. The web calendar draws them as plain "Busy" blocks.
- Someone on a sealed appointment's staff must see its record (`appointment_staff_not_on_record`), and a Home card
  about it is sealed with it.
- Chosen differently from the first sketch: the appointment row isn't split into a busy copy and a hidden copy.
  Hiding the row keeps every writer and every reader as it was; the worker, which tells the client about their
  tour, reads it whole as before.
- Phones: business_v1's appointments and their customers send only `sealed = false` rows, in place. The people on
  a deal get its appointments back on the phone with the deal screens (round six).

### Step 2: the portal's sign-in (server built, 2026-10-01)

**As built** (`20261014000200_client_portal_sign_in.sql`):

- `app.portal_access`: one per person a business lets in, with the link's `public_ref` and `link_version`. The link
  is `/c/<public_ref><code>`, the code an HMAC the worker signs (`apps/worker/src/portal/links.ts`, purpose
  `hfos:portal-links:v1`), so nothing secret is kept. Turning it off raises the version, and so does letting them
  back in: a link sent before says it was replaced (`portal_link_stale`) or that the portal is off
  (`portal_access_off`). A trigger keeps the version going up only.
- `app.portal_codes`: the six-digit code, kept as a hash. Ten minutes, three an hour, five tries; the code logic is
  shared with website chat's (`packages/core/src/verify/code.ts`). It goes only to the email on file.
- `app.portal_sessions`: a signed-in device. The worker makes a random bearer, keeps only its sha256, and hands the
  bearer to the browser once. It lasts 30 days from its last use and 90 at most, and every one ends when access is
  turned off or the link changes.
- Everyone in the business sees who has access and their devices, never a hash or a code. Only people who may
  change customers (`records.write`) let someone in or turn it off. Codes and the lookups are the worker's.
- Commands: `portal_access.give` (also sends the link again), `portal_access.revoke`, `portal_access.get`, and the
  worker's `portal_code.send`, `portal_code.check`, `portal_session.seen` and `portal_session.end`. Without an
  email on file, giving access is refused as `portal_no_email`.
- The invite goes out from the business through `message.send` on `portal.access_given`, so it sits in the
  client's conversation. The code email comes from HandsFreeOS, like other sign-in codes.
- Worker routes: `GET /public/portal/:token`, `POST …/code`, `POST …/verify` and `POST …/sign-out`, with a honeypot,
  per-address limits, and `no-store` answers. Audit rows say "via client portal".
- Waiting for the boards: the web's `/c/<token>` page, the customer page's "Client portal" card and the browser
  test.

### Step 3: the customer actor and add-ons' portal pages (server built, 2026-10-01)

**As built** (`20261014000300_customer_actor.sql`, `20261014000400_customer_portal_reads.sql`):

- `actor_type` gains `customer`, in a file of its own. The kernel's `CustomerActor` (person, device session, business)
  runs only operations that list `'customer'` alone. Those are named `portal.*` (core's) or `<id>.portal.*` (an
  add-on's), ask no permission, have no `ai`, and are risk 2 at most. A registry test and `customerOperationIssues`
  hold every operation to that.
- Look-ups run as a new role, `portal_actor`, which only the worker can become (`asCustomer`). It reaches `app` and a
  small schema of its own, `portal`, never `private`. The database works out who is asking from the device's session
  alone, and only while it's still signed in. Then it shows them:
  - themselves, in a few columns;
  - the business's name;
  - the records they're on through a relationship type marked `portal_visible`, while its add-on runs;
  - an add-on's rows about those records, through `private.addon_portal_policies(table, record column, columns)`
    (select only, the columns named).
- Changes run as the service actor in their business, as booking, invoices and chat already do, so each handler checks
  the record is theirs (`private.portal_records_for`). History records the customer as `actor_type` `customer`, with
  the person as `actor_id`, on channel `portal`. The session is checked again in the same transaction, so a device
  signed out a moment ago gets `portal_signed_out`.
- Only an add-on's own types can show records in a portal, between a customer and one of its kinds (a check). The
  worker sets the flag from the manifest on every install. Real Estate's `realestate_client` has `portal: true`.
- Manifest: `relationshipTypes[].portal` and `ui.portal` pages (path, title, the customer query shown), checked by
  `manifestIssues` and `addonModuleIssues`.
- Core's first customer query is `portal.home`: the business, the customer's name, and the add-ons with portal pages
  for records they're on.
- Worker: `POST /public/portal/op/:name` for a signed-in device, 120 a minute per device. The business comes from the
  device, never the body. None of this is in the API or its OpenAPI.
- Chosen differently: the worker's own code commands are `portal_code.send` and `portal_code.check`, so that only
  customer operations are named `portal.*`.
- Waiting for the boards: the web's `app/c/[token]/a/<id>/…` pages and their `portalPage` gate. They come with the
  portal screens in step 15.

### Step 4: client uploads (server built, 2026-10-01)

**As built** (`20261014000500_customer_uploads.sql`):

- `app.files` gains `uploaded_by_person_id` (the customer who added it; a trigger lets only the worker set it) and
  `portal_visible`. Only files on a customer or on a record can be in a portal (a check).
- A customer adds a file in three moves:
  - `portal.upload_begin` reserves its place, on them or on a record they're on. It must be a PDF or a photo (JPEG,
    PNG, HEIC, WebP), 20 MB at most, and 30 a day.
  - The worker's `POST /public/portal/uploads` gives their browser a one-time Storage upload link
    (`ObjectStore.signedUploadUrl`).
  - `portal.upload_confirm` checks what actually arrived. A wrong type or too big a file is removed there and then
    (`accepted: false`, and `file.deleted` takes the object away). A good one emits `file.attached`, so it's
    fingerprinted, and goes on the record's timeline as the customer's.
- Storage's own type list for the attachments bucket also refuses a web page outright.
- The business shows its own files with `file.share_to_portal` (risk 2, `records.write`). A customer's own files stay
  in their portal (`portal_file_theirs`).
- `portal.files` lists what the customer sees; row security picks it. `GET /public/portal/files/:fileId` gives a
  five-minute link to one, if row security shows it to them.
- Chosen differently from the plan's names: `portal.upload_begin` and `portal.upload_confirm`, not
  `file.begin_customer_upload`, so every customer operation is `portal.*`.
- Waiting for the boards: the customer page's file list showing "From the client" and a "Show in portal" switch.

## Not in round two

- The MLS, e-sign, forms, lender, title, insurance and showing connectors (round five), so no automatic search,
  showing requests or contract filling yet.
- Route planning and drive times between a tour's homes, and lockbox details.
- The listing side (round three) and contract reading (round four).
- Phone screens (round six); their links are ready.
