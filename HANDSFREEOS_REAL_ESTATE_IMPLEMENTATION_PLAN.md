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

### Step 5: portal messages in the Inbox (server built, 2026-10-01)

**As built** (`20261014000600_portal_channel.sql`, `20261014000700_portal_messages.sql`):

- A new channel and timeline kind, `portal` (the enum values alone in their file).
- **One thread per client per record**, not one per client: counterpart `portal:<person>:<record>`, the record in the
  new `conversations.custom_record_id`, assigned to the record's main person when it starts. A thread on a private
  record is sealed with it (`keep_sealed`), so round one's rules decide who reads it: the people on that deal,
  owners, admins and whoever sees every deal (Chris's rule). Its messages (`unseen_sealed_conversations()`), its
  timeline lines (logged on the deal) and its Home cards follow it. A client with two deals has two threads, each
  seen by that deal's people.
- The client: `portal.message_send` (about a record of theirs, 100 a day, filed once per `clientId`),
  `portal.messages` (their thread, newest last, with who wrote each reply) and `portal.mark_read`. Under row security
  as `portal_actor` they read only their own portal threads, in a few columns.
- The team: `message.send` on channel `portal` (`sendPortal`). It goes out as `message.sent`, never queued for a
  carrier. The AI teammate and workflows never answer a portal, a portal thread can't be texted, called or linked to
  someone else, and it carries no attachments (a file goes to the portal with `file.share_to_portal`).
- The worker marks a person's reply sent (`portal_message.mark_sent`). If the client hasn't read it ten minutes later,
  `portal.unread_notice` emails them a link to their portal and nothing of what was said, once per batch, and not if
  their portal is off.
- Every place that named the channels now names `portal`: the Inbox's words, rows and lanes ("Client portal · deal"),
  Home's words, the timeline, the Assistant, workflows' conditions, the team's emails, the push words. Contact AI
  reads no sealed thread or note, so nothing said about a private deal becomes a tag everyone sees.
- Push: a client's message pushes like any customer's, without a channel in its data. The phones people have now
  would drop a push naming one they don't know, and their Reply falls back to a text, which the server refuses on a
  portal thread. The phone's own portal threads come with its deal screens (round six), and so does a Reply that knows.
- Phones: business_v1's and me_v1's conversations and messages send only `channel != 'portal'`, in place, batched with
  step 1's narrowing.
- The web Inbox answers a portal thread like a website chat (replies stay where they were written), with a door icon
  and "Client portal". The boards' finished look comes with the staff screens.
- Chosen differently from the plan's names: `portal.message_send` (the client sends; the plan said `message_receive`).

### Step 6: homes and the buyer's profile (server built, 2026-10-01)

**As built** (`20261014000800_realestate_homes.sql`):

- `buyer_profiles` (one per buyer deal) and `buyer_profile_versions` (each save as it was, append-only): price range,
  areas, kinds of home, bedrooms, baths, size, move-by date, must-haves, deal-breakers.
  `realestate.buyer_profile.save` saves it whole, and an unchanged save changes nothing. Areas, must-haves and
  deal-breakers go through the fair-housing word list, and a phrase on it is refused with what to say instead
  (`realestate_fair_housing`).
- `homes`: address (one per address on a deal, compared loosely), who added it (the agent, the client or later the
  MLS), a listing's link (kept, never read), the pasted listing words, facts with the words each came from, the
  facts' state, and where the agent has it. `home_reactions`: each client's own save or pass. Both open to the
  client's portal for their deal (`addon_portal_policies`), without the pasted words or the sources.
- `realestate.home.add` (the AI may add one on its own: risk 1). With pasted words, the worker asks the model for
  the facts (`LISTING_FACTS`). `checkedListingFacts` keeps a fact only when its quote is word for word in the
  listing (`quoteFoundIn`, now shared with contact AI) and its number is in its quote. Then
  `realestate.home.fill_facts` (the worker's) leaves them suggested. A model that can't be asked leaves the agent a
  note to type them in.
- `realestate.home.confirm_facts`: only a person, never the Assistant. `realestate.home.set_status`: saved,
  shortlisted, toured, offer made, passed, removed.
- `realestate.homes` gives each home with its fit (pure `homes.ts`): budget, area, kind, beds, baths and size, each
  met, missed or not known yet. Must-haves are the agent's to judge.
- History gains `client` as an actor, and duty proof can be one of the add-on's own rows (`ref_kind`, `ref_id`) for
  step 13.
- The stand-in model reads listings the plain way (`scriptedListingFacts`).

### Step 7: buyer memory (server built, 2026-10-01)

**As built** (`20261014000900_realestate_buyer_memory.sql`):

- `memory_items`: one thing the buyer said (likes, can't stand, must have, deal-breaker, timing, money, other), in a
  few words, with the quote it came from and where (a message, a call, a note), or typed in by a person. Suggested by
  the AI or added by a person; confirmed, rejected or retired by a person. `deals.memory_read_through` is how far the
  AI has read.
- `realestate.memory.add`: a person's is kept; the AI's (the Assistant's `realestate_remember`) waits as a
  suggestion. Words on the fair-housing list are refused, and the same thing twice is refused
  (`realestate_memory_already`).
- `realestate.memory.decide`: confirm (the words may be fixed), reject, or retire something no longer true. Only a
  person, never the Assistant.
- The worker reads a deal ten minutes after the client's message or transcribed call, once for a burst, or at once
  when the agent asks (`realestate.memory.request`). It reads only what's new since it last looked (by when
  HandsFreeOS got it, so a transcript that comes late is still read), oldest first, a batch at a time. It reads the
  client's own messages (a website chat only once they proved who they are, as contact AI does; a private thread
  only when it's this deal's), their call transcripts, and the team's notes on the deal or the client (never another
  deal's).
- `checkedMemory` keeps an item only when its quote is word for word in what was read, nothing on the fair-housing
  list or that the model calls protected, and nothing already kept or turned down. Only a count of what was dropped
  is kept, on the event. `realestate.memory.suggest` (the worker's) writes the rest as suggestions.
- While suggestions wait, the deal's main agent has an `info` note on Home, linking to the deal's buyer tab; it
  clears when none wait.
- The stand-in model reads a buyer's sentences the plain way (`scriptedBuyerMemory`).

### Step 8: tours and the agreement rule (server built, 2026-10-01)

**As built** (`20261014001000_realestate_tours.sql`):

- `tours` (one per appointment: when, who leads it, the agreement it rested on or the exception that let it
  through, whether it happened), `tour_stops` (the homes in order, each seen or skipped, with the team's note) and
  `tour_feedback` (each client's "loved it", "maybe" or "not for us" on a home they saw, with a rating and words). All
  three open to the client's portal, without the team's notes.
- `realestate.tour.plan` (risk 2; the Assistant's `realestate_plan_tour`, which a person OKs) books one appointment
  through core's `appointment.create`, in the same transaction: the agent's calendar, the deal's client on it, the
  homes in order in its notes, the first home as its place, half an hour a home unless told. The deal makes it
  private, so others see only "Busy" (step 1).
- The calendar is the one asked for, else the new `tourCalendarId` setting (Settings → Real Estate), else the one
  active calendar the agent is on. Otherwise it's refused, saying where to pick one (`realestate_tour_calendar`).
- **The agreement rule**: the deal needs a signed `buyer_agreement` document and a "Buyer agreement ends" date on or
  after the tour's day (two dates that disagree count as the earlier). Refused as `buyer_agreement_needed` (none, or
  no end date) or `buyer_agreement_expired`, saying what to add and where. An exception needs Approve exceptions
  (`realestate.except`, now described as covering this) and a person; the AI is refused. Its reason is kept on the
  tour and in the deal's history. A tour already let through keeps its exception when it moves.
- `realestate.tour.set_stops`, `.reschedule` and `.cancel` change the appointment with it (`appointment.update`,
  `.reschedule`, `.cancel`). Moving one past the agreement's end is refused, as planning is.
- `realestate.tour.record_visit` marks a home seen or skipped, from an hour before the tour starts. A seen home
  becomes "toured"; once every home is seen or skipped the tour is done. `realestate.tour.feedback` keeps a client's
  view of a home they saw, as the agent heard it (the client's own comes with the portal, step 12). The team's words
  go through the fair-housing list.
- The worker follows the calendar: when a tour's appointment is moved or canceled there (by the team, or the client
  from their booking's link), `realestate.tour.follow` moves or cancels the tour, with a history line saying so.
- `realestate.tours` gives a deal's tours with their homes and feedback, and whether the agreement lets a tour go
  ahead today, in the refusal's own words.
- Chosen for Chris: only the first client (one with an email or phone first) is on the appointment; the others see
  it in their portal. Tour stops of a planned tour can be removed (nothing about them is kept until a home is seen).

### Step 9: the CMA (server built, 2026-10-01)

**As built** (`20261014001100_realestate_cma.sql`):

- `cmas`: one per look at a home's value ("CMA 2" on the deal): the home and its facts as the agent had them, the
  range (kept when finalized), the summary and where it stands, who finalized and shared it. `cma_comps`: price,
  sold date (or asking price while pending or for sale), beds, baths, size, distance, the agent's adjustments each
  with its reason, and whether it's used. `fair_housing_checks.cma_id`: a check reads a client update or a CMA
  summary.
- Pure `cma.ts`, method 1, "adjusted price per square foot, recent sales weighted more": each used, sold comp with
  its size gives a value for the home at the home's size after the agent's adjustments; each counts half as much
  for every six months since it sold. Likely is the weighted average, low and high the lowest and highest (rounded
  down, up and to the nearest $1,000). Each comp says why it isn't counted, and warns of an old sale, a far one, or
  a much bigger or smaller home.
- `realestate.cma.start` (from one of a buyer deal's homes, its facts copied; or from an earlier CMA's comps),
  `.set_subject`, `.add_comp`, `.update_comp`, `.remove_comp` (a draft's only), `.finalize` (keeps the range;
  refused without one, saying what's missing), `.reopen` (until it's shared).
- The summary: `.request_summary` has the worker draft it from the CMA's numbers alone (`CMA_SUMMARY_SYSTEM`), then
  both fair-housing checks read it, as a client update's. `.save_summary` keeps the agent's own words, with the word
  list's check at once and the model's a moment later; `.acknowledge_flags` keeps flagged words with a reason (a
  person only). Dollar amounts the CMA doesn't support are pointed out for the agent to check.
- `.share` (risk 2) puts it in the client's portal, refused until it's final, both checks have read the summary as
  it is, and any flag is fixed or kept. The portal reads a CMA and its comps only once shared (a restrictive policy
  for `portal_actor`). A shared CMA stays as it is; another starts from it.
- `realestate.cmas` and `realestate.cma` (each comp's value, the range, the summary, its checks and why it can't be
  shared yet). The stand-in model writes a plain summary from the numbers (`scriptedCmaSummary`).

### Step 10: offers and counters (server built, 2026-10-01)

**As built** (`20261014001200_realestate_offers.sql`):

- `offers`: one per home an offer is made on ("Offer 2" on the deal), with the listing agent it's with, who answers
  next (`waiting_them`, `waiting_us`) or how it ended (accepted, declined, expired, withdrawn), the version accepted,
  and the version whose summary is in the client's portal. One offer out on a home at a time.
- `offer_versions`: each offer and counter as it was sent, never changed (append-only): ours or theirs, when, price,
  earnest money and its days, seller credit, inspection days, loan type and its days, the appraisal condition,
  closing, other terms, the time it must be answered by, and the team's note. `documents.offer_version_id` says
  which uploaded document a version is; the offer shows that document as it stands now (its newest version).
- `realestate.offer.start` (the home becomes "offer made"), `.add_version`, `.attach_document`, `.share_summary`
  (the one-page summary in the portal; the portal reads only the shared version, never the note),
  `.record_response` (risk 2) and `.withdraw` (risk 2).
- Accepted: its terms go to the deal's key dates through `realestate.term.enter`, unconfirmed and marked as from the
  accepted version, for a person to check against the signed contract: acceptance, price, earnest money and its due
  date, seller credit, inspection end, loan type, financing end and closing (days counted as calendar days after
  acceptance). A deal at Offer or Negotiation moves to Under contract. Declined, passed or withdrawn with no other
  offer out, the deal takes the lost path (`realestate.deal.record_offer_lost`) back to Touring.
- Pure `offer-words.ts`: the terms in the client's words, the one-page summary (its title, the terms, what happens
  next) and the clock ("2 h 14 min left").
- The worker's clock (`realestate.offer_clock`): two hours before a version's deadline (at risk), at it (critical)
  and an hour after with no answer (critical), each only while that version is still the one waiting; a newer
  version or an answer clears it. Turning the add-on off cancels it with its other work; turning it on arms what's
  still ahead.

### Step 11: financing, inspections and repairs (server built, 2026-10-01)

**As built** (`20261014001300_realestate_financing_inspections.sql`):

- `financing` (the lender, loan officer and loan) and `financing_steps` (preapproval, application, rate lock,
  appraisal, conditional approval, clear to close, the Closing Disclosure, funding): each step's dates, amount and
  rate as it goes. `realestate.financing.mark_done` is a person's only, with proof (one of the deal's documents, a
  file on it, or the lender's message in the Inbox); `.reopen_step` takes it back with a reason.
- The dates duties rest on come from it, as the lender's: a preapproval's or rate lock's end, and the day the Closing
  Disclosure was received, go to the deal's key dates.
- Pure `closing.ts`: the Closing Disclosure's deadline (`cdDeadline`: three business days before closing, Saturdays
  counting, Sundays and federal holidays not, as the federal rule counts them), each step's line, and warnings (a
  lock or preapproval ending before closing, an appraisal under the price, a late Closing Disclosure).
- `inspections` (kind, inspector, when, the report as one of the deal's documents) and `inspection_findings` (what,
  where, how serious, the estimate, the client's priority and what to ask for). The deal's first report is the moment
  "the inspection report is in", with its duties.
- `repair_requests`: each version of the request and each answer of the seller's, never changed. The request is
  drafted from the findings (`repairDraft`: what the client didn't skip, must-fixes first) and edited before it's
  kept as sent. The seller agreeing is the moment "repairs are agreed", with its duties.
- The client's portal reads the steps' status and dates, the inspections, findings and requests; never the team's
  notes or the proof.
- The wire-fraud rule stands as it was: nothing here touches wiring.

### Step 12: the client's tasks and portal operations (server built, 2026-10-01)

**As built** (`20261014001400_realestate_client_tasks_portal.sql`):

- `client_tasks` (upload, sign off on exact words, or do; for one client or every client; due date; an upload's
  document kind) and `client_task_completions` (each client's own part: their file, the exact words they signed
  off on, or a teammate's note when done for them). The usual tasks are ready made (`CLIENT_TASK_PRESETS`:
  preapproval letter, signed buyer agreement, photo ID, repair sign-off, closing items), with the agent's first
  name in their words.
- Done: a sign-off once every client it's for has signed off, word for word; anything else once one has
  ("Waiting on Tuan"). An upload of a kind of document becomes one of the deal's documents, so it can prove its duty
  (step 13). Staff: `realestate.client_task.add`, `.cancel`, `.mark_done` (a person, with a note; never a sign-off)
  and `realestate.client_tasks` (with each client's portal state: none, invited, signed in, revoked).
- The client's own operations (actors `customer` alone, named `realestate.portal.*`, run through the worker's
  portal door): `realestate.portal.deals` and `.deal` (where it stands in their words, `CLIENT_STAGE_WORDS` and five
  steps, the key dates that count, their to-do, the homes and their own and co-buyers' reactions, tours and their
  own feedback, shared CMAs and offer summaries, the financing steps), `.home.add`, `.home.react`,
  `.tour.feedback`, `.task.complete` and `.task.attach` (only a file they uploaded to that deal).
- Look-ups run as `portal_actor`, each naming only the columns opened to the portal. The portal now reads a deal's
  side and stage, its key dates (dates only; two that disagree wait for the agent), the business's time zone, its
  main agent's name and the co-buyers' first names (`portal.record_owners()`, `portal.record_people()`). A task for
  one co-buyer is theirs alone.
- The manifest's portal pages: "Your deals" and "Your deal" (`deals/:dealId`).

### Step 13: duty hooks (built, 2026-10-01)

**As built** (no migration; `ops/proof-hooks.ts`):

- One helper, `addProof`, adds a record's proof to the open catalog duties it answers, once each; `documentProof`
  adds a document to every open duty whose proof names its kind; `withdrawProof` takes proof back with a reason.
  Nothing finishes a duty on its own, done, waived or cancelled duties are left alone, and the catalog and its version
  don't change.
- What counts where: a planned tour is B-05's (and B-14's) appointment, taken back if the tour is canceled; the
  agent's note on a home seen is B-06's note; each client's tour feedback is B-08's note; a finalized CMA is linked to
  B-10/B-15; an offer is linked to B-11/B-16, an accepted one to B-17, and a lost one is B-13's note; an inspection on
  the calendar is B-19's (and a specialist's, B-22's) appointment; the inspection report counts for B-21; the repair
  request is B-24's note and is linked to B-25 with the seller's answer.
- Documents by kind: the client's uploads (the buyer agreement for X-01, the preapproval for B-02), a financing step's
  document proof, an offer version's document, the inspection report, and any document marked signed.
- Links to the add-on's own rows are `record` proof (`ref_kind`, `ref_id`): shown on the duty, never enough on their
  own to meet a rule that asks for a document, note or appointment.

### Step 14: staff screens (built, 2026-10-01)

**As built** (`20261014001500_realestate_memory_dropped.sql`; the web in `apps/web/src/addons/realestate/`):

- A buyer deal's page reads its buyer side too and adds boards 13's cards: What they want, Homes and Tours in the
  main column; Buyer agreement, Financing, Client's to-do and Offers and CMA at the side. "Plan a tour" is in its
  header, and its description names the clients and when they joined the portal (`client_tasks.clients[].portalSince`).
- Pages under `deals/:dealId/`: `buyer` (What they want: the AI's suggestions to confirm, what's confirmed, the profile
  and "Add one yourself"), `homes` (`?add=1` Add a home, `?home=<id>` one home), `tours` (`?plan=1` Plan a tour, with
  `&home=<id>`), `cma/:cmaId`, `offers` (`?start=<homeId>` Make an offer), `offers/:offerId`,
  `offers/:offerId/summary` (the one-page summary, to print or share), `financing`, `inspections` and
  `client-tasks` (`?invite=1` Invite to the portal). Each is in the manifest's `ui.phone`.
- Add a home waits for the worker to read the pasted text, then shows each fact with its words to tick and confirm
  (or type in). A refused tour shows the rule's own words; an owner or admin gets the reason field and "Let it
  through", and the calendar's warnings are shown to accept.
- Buyer memory alerts open `deals/:dealId/buyer`. The deal keeps how many suggestions fair housing rules left out
  (`deals.memory_protected_dropped`), a count only, and the page says so.
- Settings → Real Estate → Alerts & dates picks the calendar tours go on (`tourCalendarId`).
- Amounts the CMA works out read to the nearest $100 (`roundedMoney`), and fit's counts have their commas.
- The calendar's "Busy" (step 1) and the Inbox's portal thread (step 5) were already built as their boards show.
- Browser test: `apps/web/e2e/realestate-buyer.spec.ts` (a pasted listing read and confirmed, a tour refused then let
  through, a member off the deal seeing only Busy). Step 15 adds the client's side to it.

### Step 15: the client's portal on the web (built, 2026-10-01)

**As built** (no migration):

- Core's portal at `/c/<link>` (`apps/web/src/app/c/[token]/`, `apps/web/src/components/portal/`): the sign-in
  (board 26: "Email me a code", then the six digits, pasted or typed), the frame with the business on top and a menu
  at the bottom, Home (board 27), Messages (board 31) and Files. Everything is read in the client's browser through
  `lib/api/public-portal.ts`; the device's bearer is kept in its localStorage under the link, and a device signed out
  elsewhere goes back to the sign-in.
- The registry's new `portal` entry gives an add-on its part: cards on Home and one component for its pages
  (`a/<id>/<path>`, only paths its `ui.portal` declares). Its pages without an id are places in the menu.
- Real Estate's portal (`apps/web/src/addons/realestate/portal/`): on Home, each open deal, what's coming up and the
  first of the to-do; **Homes** (board 29, save or pass, "Add one you found"); **To do** (uploads, sign-offs, things
  to do, and "Leave feedback" after a tour); a deal (board 28); a tour's homes to say what they thought (board 30:
  stars, what they liked and didn't, "Loved it / Maybe / Not for us"; the board's chips changed to these first); an
  offer's one-page summary. The manifest's `ui.portal` gains `homes`, `todo`, `deals/:dealId/tours/:tourId` and
  `deals/:dealId/offers/:offerId`.
- A tour's homes can be marked seen from the hour before it starts, as the server allows.
- Browser test: `realestate-buyer.spec.ts` now goes on to invite the client, sign in on a phone with the emailed code,
  pass on a home, leave feedback on one seen and message the agent; the agent then has the feedback on the tour, the
  pass on Homes and the message in the Inbox.
- Docs: docs/realestate.md (round two's screens and rules), docs/addon-architecture.md (the portal on the web) and
  CLAUDE.md.

## Not in round two

- The MLS, e-sign, forms, lender, title, insurance and showing connectors (round five), so no automatic search,
  showing requests or contract filling yet.
- Route planning and drive times between a tour's homes, and lockbox details.
- The listing side (round three) and contract reading (round four).
- Phone screens (round six); their links are ready.

# Round three: Listing core

The spec's **Listing core** release (§23): seller intake, preparing the home, the listing record, marketing with
approvals, offer comparison and the seller's side from contract to close, plus the seller's own pages in the portal.
Chris decided every question below on 2026-10-01, after watching round two's walkthrough.

## Decisions (Chris, 2026-10-01)

| Question                         | Answer                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The seller's portal              | **The same portal** the buyers use, showing the seller's listing.                                                                                                                    |
| The home's facts                 | **Three ways:** the seller fills in a questionnaire in the portal, the agent pastes the home's old listing text (the AI reads it), or the agent types them. The agent confirms them. |
| Showings                         | **Wait for the showing connector** (round five).                                                                                                                                     |
| Showing feedback                 | **Waits with it.** When it comes, the seller sees the feedback after the agent has checked it.                                                                                       |
| The listing description          | **The AI drafts it**, with both fair housing checks; the agent edits it; **the seller signs it off**.                                                                                |
| Before the listing is on the MLS | **Everything public waits** until the listing is live on the MLS.                                                                                                                    |
| Marketing                        | **A public page for the listing, a printable flyer, an email or text to the business's contacts, and drafts of social posts.**                                                       |
| Open houses                      | **A sign-in page** that visitors open from a QR code.                                                                                                                                |
| Offers on a listing              | **Side by side, with what the seller would take home** from each.                                                                                                                    |
| Matching to buyers               | **Suggested to the buyer's agent:** a listing that fits one of the business's own buyers is suggested to the agent on that buyer's deal.                                             |
| A price change                   | **The seller signs it off** before the new price is used.                                                                                                                            |

Chosen for Chris, open to change:

- Nothing lets a listing be marketed publicly before it's on the MLS. That's the MLS's rule, not the brokerage's.
- An owner or admin (Approve exceptions) can let a description or price change through without the seller's sign-off
  in the portal, with a reason that's kept ("signed on paper"), as tours were.
- An open house needs no sign-off from the seller; the seller sees it in the portal.
- A visitor who says they're working with another agent is recorded, but never made a lead or texted.
- The seller's choice on an offer in the portal tells the agent what they want. It isn't an acceptance: the contract
  is still signed elsewhere.
- Matching looks only at the business's own buyer deals. The listing's side sees how many were suggested, never who.
- What the seller takes home is an estimate, and says so, with the figures it used kept beside it.
- Photos on the public page are links that work for an hour.

## How it works

- **Core first.** Two pieces any add-on can use: **public pages** (an add-on's pages anyone can open, signed out, run
  only through operations that say so, as booking pages and forms are), and **campaigns from exact words** (an add-on
  hands Campaigns the words to send, and Campaigns' approvals and consent rules apply as they are).
- **The listing** is a record of its own beside the deal: the home's facts and where each came from, its photos, its
  descriptions, its prices, and when it went live on the MLS. Everything public reads only what the seller signed off
  and the agent published.
- **The AI** reads pasted listing text for facts, drafts the description and the social posts, and every word it
  writes goes through both fair housing checks before anyone can send it.
- **Round two's buyer pieces** work on a listing too, from the other side: the CMA prices the listing, offers come in
  from buyers and the seller counters, the buyer's inspection brings a repair request to answer, and the financing
  tracker follows the buyer's loan.

## Build order (round three)

`main` moved past round two's numbers while this branch was open (it holds `20261016000100`), so round three's
migrations start at `20261020000100`. Before anything goes live, rounds two and three's migrations are renumbered
above whatever `main` holds then; none of them is on the hosted database. Screens wait for Chris to approve the
boards; the server steps go ahead meanwhile.

- **Step 0:** this part, and the boards in `design/realestate` (numbers 32 to 49).
- **Steps 1–2 (core):** add-on public pages; campaigns from exact words.
- **Steps 3–12 (Real Estate):** the listing and its facts; the description and its sign-off; live on the MLS, and the
  hold; marketing; open houses; offers side by side; the CMA, inspections and the buyer's loan on a listing; price
  changes; matching to buyers; the seller's portal.
- **Step 13:** the staff screens. **Step 14:** the portal's and public screens, the docs, the browser test and a short
  video.

### Step 1: add-on public pages (built, 2026-10-01)

**As built** (no migration):

- The kernel's new actor, `PublicActor { workspaceId, organizationId, site, visitor }` (`kernel/types.ts`), runs only
  operations whose `actors` list `'public'`, and only in the business whose page it is. Its look-ups and changes run as
  the service actor there, as forms and booking pages do, on the forms' channel (`booking_page`), and stop while the
  add-on is off. It's recorded as the system with `actor_role` `public` and `_public: { site, visitor }` on the event;
  `visitor` is an HMAC of the address under the chat's key, never the address. `storedActorType` is what an
  activity row records for it.
- `publicOperationIssues` (`addons/server.ts`): a public operation is named `<id>.public.*`, is for visitors alone,
  asks no permission, isn't offered to the AI, and is risk 2 at most (a form's answers' own: it can make a customer
  and a lead). Core has none.
- The manifest's `ui.public` (`AddonPublicPage { path, query }`), checked by `manifestIssues`, and by
  `addonModuleIssues` to show one of the add-on's public queries.
- The worker's two doors (`apps/worker/src/http/addon-public.ts`): `POST /public/addon/:site/query/:name` and
  `…/command/:name`. The booking site's name finds the business (`private.booking_route`); anything not made for
  public pages, and a site that isn't one, is "There’s no page at this address". The forms' limits and bot check, a
  honeypot on changes, and `no-store`. Every `{ publicFileId }` in an answer gets a `url` that works for an hour, once
  the file is checked to be the business's own and ready.
- The web's `/a/<site>/<addon>/<path>` (`apps/web/src/app/a/[site]/[addonId]/[...path]/page.tsx`): the path is matched
  to the manifest's `ui.public` (`lib/addons/public-pages.ts`), its query read on the server once per request
  (`lib/api/public-addon.ts`), and the registry's new `public` entry draws it. `/a/` is served on a business's own
  domain too.
- `crm/signup.ts`: `signUpFromPage` finds or makes the customer, opens a lead when the business's forms' Lead intake
  would, and keeps a yes to texts with its source (`recordSmsConsent`, which `form_response.submit` now uses too).
  A command that calls it lists `SIGN_UP_EVENTS` in its `emits`.
- Tests: `packages/core/test/public-kernel.test.ts` (runs as the service actor, refused other operations, businesses
  and a turned-off add-on, the record, the sign-up and its consent, the rules), `apps/worker/test/addon-public.test.ts`
  (the doors' refusals; Real Estate's pages are tested through them in step 6), `branded-paths.test.ts`.

### Step 2: campaigns from exact words (built, 2026-10-01)

**As built** (no migration):

- `campaign.create` takes `words`: `{ text }` for texts, `{ subject, body }` for an email. A text's words are every
  picked person's draft at once, ready for review; an email's are the campaign's email, which the worker's drafting
  already keeps when it's there. The AI writes nothing for either, and the drafting job moves it straight to review.
  An AI call refuses words, and words missing their part are refused, each saying what to write.
- Who it picks and leaves out, the postal address, the 500 limit, approval and every consent rule are unchanged.
- An add-on starts one through `executeCommandWithin`, as the person who clicked, so it needs their Workflows
  permission like any campaign.
- Tests: `campaigns.test.ts`, `email-campaigns.test.ts`, the worker's `automations-email-campaigns.test.ts`.

### Step 3: the listing and its facts (server built, 2026-10-01)

**As built** (`20261020000100_realestate_listings.sql`; `ops/listing.ts`, pure `listing.ts`):

- `listings` (one per listing deal, made the first time anything is kept on it), `listing_photos` and
  `seller_questionnaires`, each following its deal's privacy; the seller reads their listing's facts, photos, MLS
  number and page, and their own questionnaire.
- The facts are round two's home facts without a price: the list price is the deal's `list_price` term, read as it
  stands (`listPriceOf`). `realestate.listing` shows each fact's confirmed value and where it came from, and what the
  seller's sent questionnaire and the old listing say (`factChoices`, with `disagree` when they differ).
- `realestate.listing.paste` keeps the old listing's words; the worker reads them as it reads a buyer's home
  (`apps/worker/src/addons/realestate/listing.ts`), leaves out the old price, and records what it found through
  `realestate.listing.fill_facts`. `realestate.listing.confirm_facts` is a person's only, and is S-09's proof.
- `realestate.listing.request_questionnaire` asks the seller once: a client task of the new kind `questionnaire`,
  which the portal finishes by sending answers (step 12), never by "Done".
- Photos: `photo_add` (one of the deal's uploaded images, at the end; S-18's proof once it's open at Coming soon),
  `photos_arrange` (every photo, in order, with captions and whether the page shows it) and `photo_remove` (the file
  stays in the deal's files).
- `client_tasks` gain `ref_kind`/`ref_id`, for a sign-off that moves a description or a price on (steps 4 and 10).
- Tests: `packages/core/test/addons/realestate-listing.test.ts`, `apps/worker/test/realestate-listing.test.ts`.

### Step 4: the description, and the seller's sign-off (server built, 2026-10-01)

**As built** (`20261020000200_realestate_listing_descriptions.sql`; `ops/description.ts`):

- `listing_descriptions`: every draft and every save is its own version, kept as written (2,000 characters at
  most: the seller signs off the exact words). The one being worked on replaces the one before it, taking back its
  sign-off task; the one signed stays in use until a newer one is signed. `fair_housing_checks.description_id`,
  with exactly one of a client update, a CMA or a description checked.
- `realestate.listing.description.request` needs the home's confirmed facts (`realestate_listing_no_facts`); the
  worker drafts it from those, the agent's notes and the seller's sent answers, and both checks read it
  (`description.drafted`). `description.save` is the agent's own words as a new version, read by the list at once
  and the model a moment later (`description.checked`). `acknowledge_flags` keeps a flag with a reason.
- `description.send` is refused while a check is still reading or a flag is open, and without a seller on the deal;
  it makes a sign-off task with the exact words (`ref_kind` `listing_description`). When the seller signs it in the
  portal, the description is in use and is S-19's proof. `description.let_through` does the same without the portal,
  for owners and admins (Approve exceptions) only, with a reason kept on the history; the checks still count.
- A staff member can't mark a seller's sign-off or questionnaire done for them (`realestate_sign_off_own`,
  `realestate_questionnaire_own`).
- The fair housing word list (`fh-words-2`) adds "growing family" and "perfect for / great for / ideal for a family".
- Tests: `realestate-listing.test.ts` (the seller signing in her portal), the worker's `realestate-listing.test.ts`.

### Step 5: live on the MLS, and the hold (server built, 2026-10-01)

**As built** (`ops/marketing.ts`):

- `realestate.listing.mark_live`: the MLS number and the day (never a day still to come), with the MLS page as
  proof if it's on the deal (S-20). A listing before Active moves there (`realestate.deal.move_stage` within).
- `requireOnMls` refuses the page, the flyer and the email or text to contacts with `realestate_not_on_mls`, in
  the board's words. Nothing lets it through. The social posts can be drafted before it; the screens offer Copy only
  once it's live.
- The page's status follows the deal (`publicStatus`): for sale, under contract or sold; withdrawn, expired or
  cancelled is "no page here".

### Step 6: marketing (server built, 2026-10-01)

**As built** (`20261020000300_realestate_listing_posts.sql`; `ops/marketing.ts`, `ops/public.ts`):

- `realestate.listing.page_publish` needs it live, its facts confirmed and a signed-off description; it gives the
  page the street for its address (`2207-juniper-trail`, then `-2`), under the business's public name. A business
  without a public name gets one from the first page, which only someone who may name it (owners and admins) can
  put up: anyone else is told to ask (`realestate_no_public_name`). `page_take_down` takes it down. S-22's proof.
- `realestate.public.listing` (the visitor's look-up, `ui.public` `:slug`) shows only what's published: confirmed
  facts in words, the photos marked for the page (the worker signs each for an hour), the signed-off words, the
  agent's name and the MLS number. `realestate.public.ask` makes a customer and a lead for the listing's agent
  through core's sign-up, keeps a yes to texts from "Listing page: 2207 Juniper Trail", puts the question on their
  timeline, and the worker alerts the agent.
- `realestate.listing.flyer`: what the printable flyer shows, refused before the MLS.
- `realestate.listing.campaign`: an email (`listingEmailWords`) or a text (`listingTextWords`) to the tags or stages
  picked, with exact words from the signed-off description and the page's link, read by the fair housing list
  first, started as a core campaign that waits in Campaigns for approval. S-22 and S-23's proof.
- Social posts (`listing_posts`): `posts_request` drafts three from the home's public facts, each read by the list
  and the model (S-21's proof); `post_save` is the agent's words, read again. `realestate.listing.marketing` is the
  marketing page's look-up: the MLS, the hold, the page, what's missing, and the posts with their checks.
- Tests: `realestate-listing.test.ts`, the worker's `realestate-listing.test.ts` and `addon-public.test.ts` (the
  page and a question through the public doors).

### Step 7: open houses (server built, 2026-10-01)

**As built** (`20261020000400_realestate_open_houses.sql`; `ops/open-houses.ts`):

- `open_houses` and `open_house_visitors`. `realestate.open_house.plan` puts it on the host's calendar as a tour is
  (the tours' calendar, else the host's only one; a private deal's shows only as busy), with no message to anyone;
  it sets the deal's `open_house` fact (S-36 to S-39 open) and is S-36's proof. `cancel` takes it off the calendar
  and closes sign-in. The seller sees their open houses in the portal.
- The sign-in page (`ui.public` `:slug/open-house/:openHouseId`, `realestate.public.open_house`) needs the listing
  live on the MLS, and is open from an hour before to an hour after. `realestate.public.open_house.sign_in`: on
  their own, a customer with a lead for the host and their yes to texts from "Open house: 2207 Juniper Trail";
  signing in again is one visit; with another agent, only their name, how to reach them and their agent's name. It's
  S-38's proof. The listing's page lists the open houses still to come.
- `realestate.open_houses` is the staff page's look-up, with the sign-in page's address once the business has one.
  `follow_up` marks a visitor followed up (S-39's proof). The worker reminds the host at 9 the next morning, the
  business's time, about anyone not followed up (`realestate.open_house_follow_up`), and clears the card once
  everyone is.
- Tests: `realestate-listing.test.ts`, the worker's `realestate-listing.test.ts`.

### Step 8: offers side by side, with what the seller takes home (server built, 2026-10-01)

**As built** (`20261020000500_realestate_listing_offers.sql`; `ops/offers.ts`, `ops/offer-compare.ts`, pure
`net.ts`):

- `realestate.offer.start` on a listing takes no home, names the buyers, and starts at "Waiting on our answer". The
  offer records the `offer_received` event (S-40 to S-45 open, S-40 and S-41's proof); a second open offer sets
  `multiple_offers` first, so S-42 opens with it. Accepted moves the listing under contract from any stage between
  Signed and Negotiation (an offer can come before the MLS) and is S-48's proof; the buyers withdrawing leaves the
  listing on the market. The buyer's one-page summary is refused on a listing (`realestate_offer_summary_buyer`).
- `net_sheets`: the figures, each save a new version (`realestate.net_sheet.save`, X-04's proof).
  `realestate.offers.compare` lines up each open offer's newest version with its estimate, the best flagged, the
  figures used and the ones before, what was last shared and what the seller said.
- `realestate.offers.share_comparison` keeps what the seller sees as it is then (`offer_comparisons`) and is S-42
  and S-43's proof. `realestate.portal.offer_choice` keeps the seller's Accept, Counter, Decline or "Let's talk" with
  their words (`offer_choices`), only on an offer they were shown and still open; it accepts nothing, and the worker
  alerts the listing's agent.
- The words: `offer-words.ts` has a listing's statuses, the side-by-side labels and the estimate's note; history says
  "Offer 2 came in from Priya Patel at $545,000" and "Maria said accept on offer 1".
- Tests: `realestate-listing.test.ts` (the estimate, pure, then on the database), the worker's
  `realestate-listing.test.ts`.

### Step 9: the CMA, the inspection and the buyer's loan on a listing (server built, 2026-10-01)

**As built** (`20261020000600_realestate_listing_repairs.sql`; `ops/cma.ts`, `ops/inspections.ts`,
`ops/financing.ts`, `client-words.ts`):

- `realestate.cma.start` on a listing takes no home: it's for the listing's own home, with its confirmed facts and
  its list price once there is one. Finalized it's S-06's proof; shared with the seller, S-07's note with the range.
  The summary's prompt now says never to tell the client what to list at, as well as what to offer or accept.
- An inspection on a listing is the buyer's inspector at the home: scheduled, it's S-52's appointment.
- On a listing the buyers ask and our seller answers. `realestate.repair.receive` keeps their request as it came in
  (the moment "a repair request was made": S-53, S-54 and S-56 open), with S-53's note and its document's proof.
  `realestate.repair.record_answer` then keeps the seller's answer (S-54's note, and its signed document), agreed
  bringing S-55. `repair.send` is refused on a listing (`realestate_repair_listing`), and an answer needs a request
  without one yet. The migration drops the check that tied "them" to the answer, since on a listing "them" asks.
- The financing tracker follows the buyer's loan on a listing. The buyer's own dates (preapproval and rate lock
  ending, the Closing Disclosure received) stay on its steps, not the listing's key dates. Conditional approval or
  clear to close marked done with a letter or email is S-61's note; an appraisal or approval document counts for
  S-59 and S-61 by its kind.
- The client's task presets say which side they fit (`presetsFor`): a seller's are the listing agreement, the
  seller's disclosure, the latest mortgage statement, signing off our answer to the repair request, and leaving the
  keys. The add-a-task dialog offers only the deal's side's.
- Tests: `realestate-listing.test.ts`.

### Step 10: price changes (server built, 2026-10-01)

**As built** (`20261020000700_realestate_listing_prices.sql`; `ops/price.ts`):

- `listing_prices`: each change asked for, from and to, the exact words the seller signs, its sign-off task, and how
  it ended (applied: signed in the portal or let through with a reason, and the list price entry it made; or
  withdrawn, with why). One waits at a time. The seller reads them in the portal.
- `realestate.listing.price.propose` makes the sign-off task: "Change the list price of 2207 Juniper Trail from
  $499,000 to $489,000." It needs a list price already (the first is a key term, with no sign-off) and a seller on
  the deal, and refuses the same price or a second change while one waits.
- Signed in the portal, the change is used at once: a new `list_price` entry replaces the old one (kept in its
  history), confirmed by the agent who asked for exactly that price; the page shows it; S-34's proof; and the worker
  reminds the agent to change it on the MLS (an alert, when it's on the MLS: S-67 is the MLS after closing, so the
  reminder isn't a duty). `price.let_through` does the same for an owner or admin with a reason, and takes the task
  back; `price.withdraw` takes it back, with why.
- `realestate.term.enter` refuses a new list price on a listing with one confirmed (`realestate_price_needs_signoff`),
  so there's no way round the sign-off. Matching runs again on a new price in step 11.
- `realestate.listing.prices` is the price now, the change waiting, and every change.
- Tests: `realestate-listing.test.ts`, the worker's `realestate-listing.test.ts`.

### Step 11: matching to buyers (server built, 2026-10-01)

**As built** (`20261020000800_realestate_listing_matches.sql`; `ops/matching.ts`, `suggestsListing` in `homes.ts`):

- `realestate.match.run` (the worker's, as the system) matches one listing against every buyer deal still looking,
  or one buyer against every live listing. Live means on the market (Active to Negotiation), on the MLS, not ended
  or archived; looking means a buyer deal before Under contract with a saved profile. It reads round two's `homeFit`
  only: price, areas, kind of home, beds, baths and size. `suggestsListing`: within budget, nothing missed and one
  more thing met (an area not named is "check the area", never a miss).
- `listing_suggestions` belong to the buyer's deal, with a copy of the listing's address, confirmed facts, price,
  how they fit, its MLS number and page; a home already on the deal isn't suggested. Matching again refreshes them;
  one that stops fitting, or a listing off the market, is "gone". New ones are S-23 and S-24's note on the listing.
- The worker runs it when a listing goes live, its price changes or a suggestion is decided (that listing), and
  when a buyer's profile is saved (that buyer); new suggestions alert the buyer deal's agents ("Our listing at 2207
  Juniper Trail fits Ortiz search").
- `realestate.suggestions` on the buyer's deal; `suggestion.add` makes a home from it (source `our_listing`, its
  facts confirmed as the listing has them); `suggestion.not_a_fit` sets it aside, with why if they like.
- The listing's side sees only how many it was suggested to and how many added it (`realestate.listing`'s
  `matches`), counted by the worker, never who.
- Tests: `realestate-listing.test.ts` (the rule, pure, then on the database), the worker's `realestate-listing.test.ts`.

### Step 12: the seller's portal (server built, 2026-10-01)

**As built** (`20261020000900_realestate_seller_portal.sql`; `ops/seller-portal.ts`):

- Where it stands in the seller's words, the key dates and their to-do (sign-offs among them) are round two's
  `realestate.portal.deal`, which already reads a listing. `realestate.portal.listing` adds the rest, read as the
  customer: the address and price as it stands, each price change asked of them, the MLS number, the page's address
  once it's up, the home's facts, the description they signed, the open houses to come, their questionnaire, and
  the offers side by side as last shared, with what they said about each.
- The portal never reads the deal's amounts (round two), so `portal.listing_facts()` gives a seller, for their own
  listings only, the address, the list price and where the page is.
- `realestate.portal.questionnaire.save` keeps their answers as they go (facts merged, words replaced);
  `submit` sends them once, finishes the questionnaire task, and the worker alerts the agent until they confirm the
  facts. Refused before they're asked (`realestate_questionnaire_not_asked`), empty, or a second time.
  `realestate.portal.offer_choice` is step 8's.
- The `ui.portal` pages (the listing, the questionnaire, the offers) come with their screens in step 14.
- Tests: `realestate-listing.test.ts`.

### A speed fix for private records (core, built 2026-10-02)

Chris OK'd it on 2026-10-02. `private.private_kinds_seen_whole()` (round one's step 4) asked
`private.has_permission()` about every private kind of record in every business before narrowing to the caller's
own. Every add-on row policy reaches it through `private.unseen_private_records()`, so a query on a deal's rows cost
more with every business on HandsFreeOS. With about 1,400 test businesses, each duty update took half a second, and
ending a listing took 25 seconds.

`20261020001000_private_kinds_checked_fast.sql` narrows both functions to the caller's businesses first. Nobody sees
anything different: the private-records, portal and add-on table tests still pass. The kinds function went from
about 120ms to 5ms, and ending a listing from 25 seconds to 2.5.

### Step 13: staff screens (built, 2026-10-02)

**As built** (no migration; boards 32–43 followed closely):

- A listing deal's page: the listing card (photo, price and what it was, the MLS, the description, the page and its
  link), Offers with each one's take-home, Open houses, and at the side Marketing, the seller's to-do, Matching, the
  seller's estimate and CMAs. A Marketing button joins Key dates and Documents.
- Its pages under `deals/:dealId/`: `facts`, `photos`, `description`, `price` (`?change=1`), `marketing`
  (`?live=1`), `flyer`, `open-houses` (`?plan=1`), `offers` (a listing's side by side) and `net-sheet`. All but the
  flyer are in `ui.phone`. Offers, Financing, Inspections, the CMA and the client's to-do read right on a listing.
- What the boards showed and the server doesn't keep is left out or said as it is: "Printed Oct 10", "Sent to 214"
  and "3 people asked about it" became status words; photo credits, the TREC number and the agent's phone are left out.
- The seller's estimate works the take-home out with core's `netEstimate` as the figures are typed, and before any
  offer at the list price. The listing's offers page shows the seller's choice from the portal; answers and new
  versions are recorded from each column.
- A buyer deal's page and its Homes page gain "Fits from our listings" (`suggestion.add`, `suggestion.not_a_fit`).
- The worker's questionnaire alert opens `facts` and the price alert `price`. The hold's words name Marketing, where
  it's marked live. A printed page leaves out the app's sidebar and bars, so the flyer, the sign-in sheet and the
  offer summary print alone.
- Found and fixed on the way: the facts page kept a seller's answer picked after the old listing disagreed with it,
  so the disagreement never showed; it now waits for a pick. What they want, Homes and Tours say "not found" on a
  listing instead of erroring. The listing tests mark it live on the business's day, not UTC's.

### Step 14: the portal's and public screens, docs, the browser test and a video (built, 2026-10-02)

**As built:**

- The seller's portal (`portal/listing.tsx`): their listing (steps, price and what it was, the MLS, the page link,
  what's waiting for them, open houses, key dates); the questions about their home (save for later, then send);
  a sign-off page for exact words (`sign-off/:taskId`, the round-two buyer sign-offs use it too); and the offers side
  by side with Accept, Counter, Decline and Let's talk. Three `ui.portal` entries, each with an id in its path.
- The public pages (`public/pages.tsx`, the registry's `public` entry): the listing's page with its photos, price,
  facts, open houses, description and "Ask about this home"; the open house's sign-in, open, not yet, closed or
  cancelled. Both carry the honeypot, the bot check and core's words for agreeing to texts, and show only the
  business's name. The public frame's bottom line says what kind of page it is.
- Docs: `docs/realestate.md` (round three's screens and rules), `docs/addon-architecture.md` (public pages and
  campaigns from exact words), CLAUDE.md.
- `apps/web/e2e/realestate-listing.spec.ts` covers the seven scenarios above in one run, about three and a half
  minutes locally.

## Not in round three

- Showings and their feedback (round five, with the showing connector).
- Putting the listing on the MLS, posting to social sites, e-sign, and reading offers from their PDFs (rounds four
  and five).
- Vendors and booking the photographer, and reports on competing listings.

# Round four: Coordinator and risk

The spec's **Coordinator + risk** release (§23): contract extraction, contingencies, dependencies, health, escalation,
linked transactions and the coordinator's dashboards. Its exit outcome: exceptions replace checking tasks by hand.
Chris decided every question below on 2026-10-02, after watching round three's walkthrough.

Much of the groundwork is in already and waits to be wired up: `duty_links` has nothing reading or writing it,
`deal_links` has no screen, contingencies are only end dates, at-risk alerts never climb past the agent and the
coordinator, and the AI takes images but not PDFs.

## Decisions (Chris, 2026-10-02)

| Question                          | Answer                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents the AI reads            | **Contracts and amendments:** the parties, the money, every date and contingency, each with its clause. Inspection reports and the closing disclosure wait. |
| Scanned contracts                 | **Read them too.** The AI reads the pages; each value is marked "read from a scan" for the agent to check closely.                                          |
| What the AI reads                 | **A person confirms each value.** It waits on Key dates, unconfirmed, beside its clause. Duties that rest on a date start once it's confirmed.              |
| Removing or waiving a contingency | **The agent records it** (satisfied, waived or expired) with the signed removal form as proof. The client sees it in the portal.                            |
| Dependencies                      | **Built in, plus the agent's own.** A waiting duty shows what it waits on and who has it; a slip shows what moves.                                          |
| A linked sale and purchase        | **Watch both and warn.** Each shows the other's key dates; a slip on the sale flags the purchase to both agents.                                            |
| The coordinator's views           | **Today, Exceptions, Waiting room and Team workload.**                                                                                                      |
| Escalation                        | **Up after a business day.** An at-risk item nobody acknowledges within one goes to the business's alert people.                                            |

Chosen for Chris, open to change:

- Exporting a whole transaction (every document, date and decision in one file) waits for round six.
- An owner or admin (Approve exceptions) can record a contingency's end without the signed removal form, with a reason
  that's kept, as tours and prices are.
- A linked deal shows its key dates, its health and its agent's name to the people on the other deal. Never its
  duties, documents or messages.
- A value the AI couldn't place exactly (a date "after inspection" with no number of days, two dates for one thing) is
  listed as an exception to look at, never guessed.
- An amendment's values replace the ones before them, and the old ones are kept in the history.

## How it works

- **Core first.** The AI learns to read a PDF: a `document` block beside its image block, for both providers. The
  worker's PDF text reading moves out of the knowledge base so add-ons use it too, with a larger limit for contracts.
- **Reading a contract.** When a contract, amendment or addendum is added to a deal, the worker reads it: the text
  when the PDF has some, the pages themselves when it's a scan. Every value it finds is checked against the words
  (the quote must be in the document, the numbers must be in the quote), then waits on Key dates for a person to
  confirm, beside its clause and page. An amendment shows what it changes before anyone confirms it.
- **Contingencies** are records of their own on the deal, each with its end date, its state and how it ended. They
  come from the accepted offer, the contract or the agent.
- **Dependencies.** The catalog says which duties wait on which (the appraisal after the loan application, closing
  after clear to close). The agent can add their own. A duty shows what it waits on, and a date that slips shows
  what moves with it.
- **Escalation.** An at-risk alert that nobody acknowledges within a business day goes to the business's alert
  people. Health learns six new reasons, each with its words and a next step.
- **Linked deals.** A seller who is also buying sees both deals tied together. Each shows the other's key dates and
  health; a date on one that breaks the other warns both agents.
- **The coordinator** gets one place with four views: Today (due now or at risk), Exceptions (what disagrees or is
  missing), the Waiting room (waiting on someone outside, with when to chase) and Team workload.

## Build order (round four)

Round four's migrations follow round three's, from `20261020001100`. As before, rounds two to four's migrations are
renumbered above whatever `main` holds before anything goes live; none of them is on the hosted database. Screens wait
for Chris to approve the boards; the server steps go ahead meanwhile.

- **Step 0:** this part, and the boards in `design/realestate` (numbers 50 to 61).
- **Step 1 (core):** the AI reads a PDF.
- **Steps 2–7 (Real Estate):** reading contracts and amendments; contingencies; dependencies; escalation and health;
  linked deals; the coordinator's views.
- **Step 8:** the screens. **Step 9:** the docs, the browser test and a short video.

### Step 1: the AI reads a PDF (built, 2026-10-02)

- `packages/ai`: a `document` content block (`{ type: 'document', mediaType: 'application/pdf', data }`), sent to
  Anthropic as a base64 document and to OpenAI as a file, with a size and page limit. The scripted provider passes it
  through, so tests can match on the prompt.
- `apps/worker`: PDF text reading moves to `files/document-text.ts` with the byte limit as a parameter, so the
  knowledge base keeps its 5 MB and add-ons read 25 MB contracts. A helper reads a file's bytes after checking it
  belongs to the business.

**As built:** `AI_DOCUMENT_MAX_BYTES` is 20 MB (its base64 stays under the 32 MB request) and `AI_DOCUMENT_MAX_PAGES` 100. A PDF is cached like a picture, and counted by its pages when a stand-in guesses tokens. `files/document-text.ts`
also reads a PDF page by page (`pdfPages`), so each value can say its page; `files/read.ts` is `readFileBytes`.

### Step 2: reading contracts and amendments (S-49, X-15, X-16) (built, 2026-10-02)

- Migration: `contract_reads` (the deal, the document, its state, whether it was a scan, what was found and why it
  failed), and on `term_entries` the quote, the page, the read and the scan mark.
- `realestate.document.read` runs on its own when a contract, amendment or addendum is added, and again from "Read it
  again". `realestate.contract.read` shows the values, each beside the current one, and what an amendment changes.
- The worker tries the text first, and sends the pages to the AI only for a scan. Every value goes through
  `checkedContractTerms`: the quote is in the document, the numbers are in the quote, and a date is either a calendar
  date or "N (business) days after" a known date, worked out with the business-day calendar.
- Values land through `termEnter` unconfirmed, with their source, clause, page, quote and document. An amendment's
  values replace the current ones. Confirming them re-dates the duties. Confirming a read is proof for S-49, X-15 and
  X-16.

**As built:**

- What a reading finds is kept on the reading (`contract_reads.found`), not entered as unconfirmed key dates: a
  value waits there beside what counts now, and only a person's confirm enters it, confirmed, replacing every live
  entry of that key. That way an amendment shows what it would move before anything moves, and a disagreement with
  the accepted offer isn't a conflict on the deal while it waits. Read values waiting are a yellow reason
  (`read_waiting`), and the agent has a card until none wait.
- The parties are two new text terms, `buyer_names` and `seller_names`.
- `contract-read.ts` holds the prompt and `checkedContractRead`: a date stated outright must be in its words
  (`dateStatedIn`: "October 10, 2026", "Oct. 10", "10/10/26", "the 10th day of October"; with no year, only near
  today); a date counted from another is worked out here, in rounds, from this document or the deal's dates.
- A document with under 40 characters of words a page, on average, is a scan (a one-page amendment can be short).
  One reading at a time per document; reading again sets aside what still waited in the older one ("Read again.").
- An amendment that moves a date brings the dates the contract counts from it, worked out again ("possession at
  closing and funding" moves with the closing), in the contract's words, waiting with the rest. Only while the
  contract's value is still the one that counts.
- Ops: `realestate.document.read`, `realestate.contract.read_done` (system), `realestate.contract.confirm`,
  `realestate.contract.reject_value`, and the queries `realestate.contract.read` and `realestate.contract.reads`.

### Step 3: contingencies (X-17) (built, 2026-10-02)

- Migration: `contingencies` (kind, end date key, state, how it ended, who recorded it, the form, a note, where it
  came from).
- They come from the accepted offer (which now also writes the appraisal end date), the contract read or
  `realestate.contingency.add`.
- `realestate.contingency.resolve` records satisfied, waived or expired, with the signed form, or an owner's or
  admin's reason. It's proof for X-17 and the duty it answers.
- Health: yellow when one is open and ends within 2 business days, red when it's open past its end. The client sees
  their contingencies and how each ended in the portal.

**As built:** a contingency of a named kind ends on its key date, so it's tracked once that date is entered (from any
source) and the accepted offer starts its contingencies even before their dates exist (an appraisal contingency has
no date in the offer). One of each named kind per deal; "other" ones have their own date. The sweep raises a
`contingency:<id>` card for one past its end, cleared when it's recorded. Ops: `realestate.contingency.add`,
`realestate.contingency.resolve`, `realestate.contingencies`; the portal's deal gains `contingencies`.

### Step 4: dependencies (built, 2026-10-02)

- The catalog's rows gain `after`, for about 25 real orders. The catalog test checks each id exists and that nothing
  waits on itself.
- The engine writes `duty_links` when both duties are on a deal. `realestate.duty.link` and `unlink` add the agent's
  own (same deal, no loops).
- `realestate.duty.get` gains what it waits on, what waits on it, and what moves if it slips.
- Health: yellow when a duty due within 3 business days waits on one still open, red when that one is overdue. The
  sweep reminds a blocker's owner when its review time passes.
- Duties gain `waiting_since` and `chase_at`, for the Waiting room.

**As built:** the built-in order is `catalog/order.ts` (29 duties), beside the catalog rather than in its rows, so a
business's published duty list keeps its version. The engine writes the links on every settle, between the newest
pass of each duty. Built-in links can't be taken back (waive the first duty instead); the agent's own carry
`added_by`. `realestate.duty.chased` moves the chase day on two business days (9:00 where the business is), and
`set_status` takes `chaseOn`. The sweep raises `chase:` and `blocker:` cards to whoever answers for the duty.

### Step 5: escalation and health (built, 2026-10-02)

- Duties gain `at_risk_since` and `escalated_at`. An at-risk alert not acknowledged within one business day is raised
  again to the alert people.
- Deal settings lets an owner pick several alert people (up to 10).
- New health reasons: a contingency ending, a contingency passed, a duty waiting on one still open, a linked deal that
  disagrees, read values waiting, and waiting outside past the chase date.

**As built:** the sweep keeps `at_risk_since` while a duty's alert says at risk, and once that's a business day old
(the same time on the next business day) with nothing acknowledged, sets `escalated_at`, logs it, and the alert goes to
the alert people too, asking to be acknowledged. At-risk pushes still wait for business hours. Several alert people
already worked on the server (up to 10); the screen comes in step 8.

### Step 6: linked deals (X-35) (built, 2026-10-02)

- Migration: `private.linked_deal_facts(deal)` returns the other deal's key dates, health and agent's name to someone
  on this deal. Nothing else crosses the link.
- New checks: the purchase closes before the sale; possession out of order; the purchase's rate lock ends before the
  sale closes; the purchase's home-sale contingency ends before the sale closes.
- When a confirmed date breaks the pair, both agents are warned. Linking is proof for X-35.

**As built:** `dates/linked.ts` says each problem from the deal's own side (the purchase's own date checks keep the
closing order, so it isn't said twice). Both deals turn red (`linked_conflict`) and the sweep puts a `linked:` card
on each, for its own agent. `realestate.deal.get` returns the link's dates, health and agent even when the person
can't open the other deal (`canOpen`).

### Step 7: the coordinator's views (built, 2026-10-02)

- `realestate.today`, `realestate.exceptions`, `realestate.waiting_room` and `realestate.workload` (Workload needs See
  every deal). Each looks only at the deals the person is on, or every deal with See every deal.
- `realestate.deal.list` gains filters: agent, side, stage, closing within some days, and who a blocker is waiting on.

**As built:** Today's "at risk" is escalated duties plus each deal's reasons that aren't one duty being late. Workload
reads the people through `private.realestate_team`, so See every deal is enough without the business's member list.
Deals rows gain `waiting` (the first thing waiting outside or blocked).

### Step 8: the screens

- The contract read beside its PDF, an amendment's changes, and the contingencies page.
- On the deal page: a Contingencies card, a Linked deal card, Waits on in the duty drawer, and the reading state on
  Documents.
- A new **Coordinate** place with Today, Exceptions, Waiting room and Workload; filters on Deals; several alert people
  in Deal settings; the contingencies in the portal.

**As built** (no migration; boards 50–61, approved 2026-10-02):

- The contract's page (`contract/<read>`, `contract-page.tsx`) shows the PDF in the browser's own viewer, signed for
  ten minutes with the person's session, and opens it at a value's page. Where the browser can't show a PDF inline
  (most phones), it's a link. An amendment's page is the same one, with Was beside each value and What moves.
- Contingencies (`contingencies-page.tsx`): "Add the signed form" files it on Documents as kind Other, marked signed,
  then picks it; owners and admins get "Record it without the form" with a reason.
- On the deal page (`risk-cards.tsx`): the reading callout, the Contingencies and Linked deal cards, and what a linked
  deal breaks. "Link a deal" searches the open deals the person sees.
- The duty drawer's order (`duty-waits.tsx`) adds only waits on another duty; waiting on someone outside stays
  Waiting on…, which now takes the day to chase them. Chased and It came in sit on its callout.
- Coordinate (`coordinate-page.tsx`, menu icon Radar) loads Today, Exceptions and the Waiting room for the tabs'
  counts, and Workload only on its tab. "Agent" narrows by a deal's main agent, as the queries do.
- Deals' filters are in the address; Health is worked out in the browser, the rest by `realestate.deal.list`. The list
  shows Waiting on instead of Next duty while any deal is waiting.
- The phone's pages (`ui.phone`) gain the contract, contingencies and Coordinate.

### Step 9: docs, the browser test and a video

- `docs/realestate.md` and `docs/addon-architecture.md`, and "as built" here.
- `apps/web/e2e/realestate-coordinator.spec.ts`: a contract read and confirmed, an amendment moving the closing, a
  contingency removed, a dependency, a linked sale slipping, the coordinator's views, and an escalation.

**As built:** the spec makes its PDFs in code (`textPdf` in `realestate-helpers.ts`, as the worker's tests do), and
the scripted reader finds their values. The worker's test-only `/test/realestate/at-risk-since` ages an at-risk
duty, so the escalation shows at the next sweep without waiting a business day.

## Not in round four

- Reading inspection reports and the closing disclosure.
- Exporting a whole transaction (round six).
- The MLS, e-sign, lender, title and insurance connectors (round five), so contracts arrive by upload or email.

# Round five: Ecosystem

The spec's **Ecosystem + optimization** release (§23): connectors to the MLS, forms and e-sign, showings, lenders,
title, insurance and vendors (§19). Its exit outcome: automation expands without changing what anyone is responsible
for. Chris decided the questions below on 2026-10-02, after round four's walkthrough. He added that listing data
shouldn't mean only the MLS: suppliers such as Repliers and AnyProp sell one feed across hundreds of MLSs.

Each connector is a source of facts and evidence, never of authority (§19): every value it brings says where it came
from and when, a person still confirms what matters, and a connector that's down never marks anything done; it says
which deals it affects.

## Decisions (Chris, 2026-10-02)

| Question                       | Answer                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Listing data suppliers         | **Repliers, AnyProp and a direct MLS feed (RESO Web API: MLS Grid, Bridge, Trestle)**, all behind one listing-data connector, so more can be added.                                                                                              |
| Whose account                  | **Both.** HandsFreeOS's own account by default; a brokerage can connect its own instead, and its MLS license stays its own.                                                                                                                      |
| HandsFreeOS's own account      | **Repliers**: it handles each MLS's data agreement and sends updates as they happen.                                                                                                                                                             |
| What the listing data does     | **All four:** fill in a home's facts by address or MLS number; run each buyer's saved search and bring new matches to the agent; pull sold comps into a CMA; read our listings' status (live, price change, pending, sold) from the feed.        |
| Other connectors this round    | **Listing data first, then e-sign, showings and a vendors directory.** Lender, title and insurance keep working by upload and email.                                                                                                             |
| E-sign                         | **DocuSign and Dotloop**, one e-sign connector with both behind it.                                                                                                                                                                              |
| Showings                       | **Both:** our own showing page (a buyer's agent asks for a time on the listing's page, the seller says yes in the portal, then access and a feedback link), and ShowingTime's emails read into showings and feedback for listings already on it. |
| What clients see from the feed | **What the agent sends.** New matches go to the agent first; the client sees only homes the agent sent, with each MLS's required notice and logo.                                                                                                |

Chosen for Chris, open to change:

- HandsFreeOS's Repliers account is turned on for a business by staff when they hand it the add-on, the way testing
  grants are; its use is counted. A business that connects its own account uses that one instead.
- A value from the feed is marked "from the MLS" with its supplier and time. It fills what's empty; where it
  disagrees with what a person confirmed, both are shown and a person picks, as with any two values that disagree.
- The feed is read from a supplier's updates where it sends them, and every 15 minutes otherwise.
- New matches for a buyer come to the agent as they arrive, at most one Home card a day per buyer, never to the client.
- Our listings' status: the feed showing it Active with its MLS number marks it live on the MLS (round three's hold
  lifts), with the feed as proof. A price or status on the feed that differs from ours is flagged, never copied over.
  HandsFreeOS still never writes to the MLS.
- E-sign uses the agent's or brokerage's own DocuSign or Dotloop account (they sign in with it). The signed copy and
  its certificate come back to Documents on their own, locked, as proof.
- A showing asked for on our page waits for the seller's yes unless the listing says "confirm on its own"; the
  access instructions go only to the confirmed agent, just before the showing.
- The vendors directory is the business's own list (inspectors, photographers, stagers, contractors, lenders, title),
  each with their services, areas, approval and any disclosure; the agent picks one on a duty, and their quote,
  appointment and proof attach to it.
- Analytics and a brokerage template marketplace (also in the spec's release) wait.

## How it works

- **Core first: an add-on's connections.** A business can give an add-on an account at another service: a key it
  pastes, or a sign-in (OAuth). The worker tests and seals it (as Twilio keys and calendar tokens are), owners and
  admins manage it, and nobody can read it back. Each connection shows its health: connected, last good sync, what's
  failing and since when. An add-on's manifest names the services it connects to.
- **Core: an add-on's webhooks.** Each connection gets its own address for the service's updates. The worker checks
  the service's signature, keeps the delivery once (by the service's event id) and hands it to the add-on's worker
  half, under the same guard as everything an add-on does: off, and it's ignored.
- **One listing-data connector.** Repliers, AnyProp and RESO Web API feeds each have an adapter that turns what they
  send into one shape (RESO's field names where there are some), with each field's source and time, and each MLS's
  notice, logo and display rules. Tests use a stand-in supplier.
- **What it feeds:** a home's facts and photos by address or MLS number; buyers' saved searches and new matches; sold
  comps for a CMA; our listings' status and a check that the MLS and we agree.
- **E-sign:** send a document from Documents for signing (signers and order), watch where it stands, and get the
  signed copy and certificate back, locked, as proof for the duty that needs it.
- **Showings:** a request page on the listing's public page, the seller's yes in the portal, access instructions and
  a feedback link; ShowingTime's emails read into the same showings and feedback. Showings and feedback join the
  listing's activity, the seller's report and the price review.
- **Vendors:** the business's directory, picked on a duty, with quotes, appointments and proof.

## Build order (round five)

Round five's migrations follow round four's, from `20261021000100`. None of rounds two to five's migrations is on the
hosted database; they go there, renumbered above `main`'s, with Chris's OK before anything reaches `main`. Screens wait
for Chris to approve the boards; the server steps go ahead meanwhile.

- **Step 0:** this part, and the boards in `design/realestate` (numbers 62 onward).
- **Step 1 (core):** an add-on's connections: keys and sign-ins, sealed by the worker, with their health.

  **As built** (`20261021000100`): `app.addon_connections` and a manifest's `connectors`
  (docs/addon-architecture.md, "Connections to other services"). A key is tried by the add-on's worker half before
  the worker seals and keeps it (`POST /v1/addons/connections/key`). HandsFreeOS's own account is a `platform` row
  staff turn on, with its key only in the worker's `ADDON_PLATFORM_KEYS`; the business's own is used first, and both
  can be live at one service at once. Health counts failures, a refusal asks for the key again, and five in a row
  read "not working". Uninstalling wipes the keys; purging deletes the rows. Sign-ins (OAuth) come with e-sign
  (step 7). The tests use a made-up feed add-on (`packages/core/test/addons/connection-fixture.ts`); Real Estate
  declares its own connectors with their adapters in step 3.

- **Step 2 (core):** an add-on's webhooks: an address per connection, checked, kept once, handed to the add-on.

  **As built** (`20261021000200`): `POST /webhooks/addon/<token>`; the add-on opens a connection's address with
  `openConnectionWebhook` and gives it to the service. Updates are kept as deliveries with provider `addon` and the
  connection, once per service id, and run through the delivery runner's `addon:*` processor, set aside while the
  add-on is off. A service that doesn't sign is kept unsigned and read back from the service. HandsFreeOS's own
  account (`platform`) isn't given an address: one account serves every business, so the feed is read every 15
  minutes for those (step 3).

- **Step 3:** the listing-data connector and its three adapters (Repliers, AnyProp, RESO Web API), with a stand-in
  for tests.

  **As built** (no migration): the manifest's `listing_data` connector (managed with `realestate.manage`): Repliers
  by key or HandsFreeOS's own account, AnyProp by username and password, and a direct RESO feed by server token or
  client ID and secret. Core's `feed.ts` is the one shape (RESO's names, the MLS's notice, logo and courtesy line);
  the worker's adapters ask in each supplier's own words, AnyProp is a RESO feed with its token and MLS profiles,
  and `askFeed` uses the business's own account before HandsFreeOS's and records each answer on the connection.
  - Repliers' updates (webhooks) cover every listing on an account, with no way to ask for some, so the feed is read
    with targeted questions every 15 minutes instead; a service's updates (step 2) carry e-sign.
  - MLS Grid only copies its whole feed out, so a direct MLS Grid feed answers MLS numbers and our listings'
    status, and a broader search says it can't.
  - The stand-in MLS (60 made-up homes around Austin; `ADDON_CONNECTORS=fake`) answers every question locally,
    and HandsFreeOS's own account works there without a key.

- **Step 4:** a home's facts and photos from the feed; sold comps for a CMA.

  **As built** (`20261021000300`): with a feed connected, each new buyer's home is looked up (by its MLS number or
  its address) and `realestate.home.lookup` asks again; our listing has `realestate.listing.lookup`. The MLS's
  listing is kept on the home or listing as it said it (`mls`, with `mls_state`), fills a home's empty facts as
  suggestions, and is one more source ("From the MLS") for a listing's facts; `differs` names the facts where it
  and what a person confirmed disagree. `realestate.cma.find_comps` asks for homes sold within the miles and months
  given, similar ones first (the same kind, within a fifth of its size), placed by the home's MLS listing or its ZIP;
  they come in nearest first as comps from the MLS that don't count until ticked, never twice. Round four's
  browser-test route now registers through the worker module's `testRoutes`, so core never imports the add-on's
  folder (the boundaries test caught it).

- **Step 5:** buyers' saved searches and new matches; what the client sees.

  **As built** (`20261021000400`): a buyer's profile is their saved search (on by default; `realestate.search.set`
  turns it off), asked of the feed by `realestate.feed_check` every 15 minutes, after the first look only for what
  the MLS changed since (an hour's overlap). It needs an area (a town or ZIP code). New homes are kept in
  `feed_matches` for the agent, each with how it fits the profile; one the MLS changed since is marked, and the same
  listing is one match. The deal's agent and team get one `info` Home card a day per buyer at most, taken down once
  nothing waits. `realestate.match.send` makes a match one of the deal's homes (source `mls`, the MLS's facts as
  suggestions, no second look-up); `realestate.match.dismiss` sets it aside for good. The client's portal shows a
  home's MLS photos with its MLS's notice, logo and courtesy line, and only homes the agent sent.

- **Step 6:** our listings' status from the feed.

  **As built** (no migration): the same 15-minute feed check reads each open listing deal on the MLS, by its MLS
  number (fifty at a time) or, before it has one, by its address (ten a time). Seen Active there and not live here,
  it's marked live through round three's own path (`markListingLive`: its number and day, the MLS-input duty's proof
  and history saying the feed saw it, Active if it was before it), and the hold lifts. `listingFeedDiffers` compares
  the MLS's price and status with the deal's list price and stage; a difference is a Home card (`attention`) for the
  deal's people until they agree, and is shown on the listing (`feed.differences`). Nothing is copied over, and
  nothing is written to the MLS. `realestate.deal.move_stage` now also runs as the system, for this.

- **Step 7:** e-sign (DocuSign and Dotloop).

  **As built** (`20261021000500`, `20261021000600`): the manifest's `esign` connector (`many`: DocuSign, with
  updates, and Dotloop, both by sign-in). Core gained sign-ins for any add-on (`oauth` in a provider's `auth`; PKCE,
  a one-time state, finished only by whoever pressed Connect), worker actions (`POST /v1/addons/<id>/actions/<name>`,
  for what only the worker can ask now) and `file.store` (a file the worker brings back, kept on its record).
  - `realestate.esign.prepare` (a PDF document that isn't signed or replaced, one or more signers in order, DocuSign
    or Dotloop when both are connected) makes an `addon_realestate.esign_envelopes` row in `preparing`; the worker
    makes a DocuSign draft (`status: created`, its updates sent to the connection's own address) or a Dotloop loop
    (Loop-It, a "HandsFreeOS" folder, the PDF) and core keeps where to open it. One signing at a time per document.
  - The agent opens it with the action `realestate.esign.open` (DocuSign's sending page, made fresh, coming back to
    the deal's Documents with `?esign=`; Dotloop's loop) and sends it there; `realestate.esign.check` looks again at
    once for when they're back.
  - DocuSign's updates aren't signed with a key HandsFreeOS holds, so each one only names the envelope, which is read
    back from DocuSign; `realestate.esign_check` looks at every open DocuSign envelope every fifteen minutes, and
    stops when none is open. Dotloop says nothing about signing, so its agent presses “It's signed”
    (`realestate.esign.mark_signed`) and the worker fetches the document from the loop.
  - Done, the signed copy (DocuSign's combined PDF) and DocuSign's certificate are stored on the deal and filed by
    `realestate.esign.completed`: the copy as the document's newer version, marked signed and locked (so it's proof,
    and a contract's copy is read like any other), the certificate as an "Other document", locked. Their file ids
    come from the envelope's, so trying again keeps one of each.
  - `realestate.esign.void` (with a reason) voids it at DocuSign (a draft goes to its deleted folder); a failure to
    is kept on the envelope, saying to void it there too. Voided while it was being made, it's thrown away there once
    made. A Dotloop loop is the agent's to archive.
  - `realestate.esign.list` says where each stands (`esignWords`, `signersWords`) and which services are connected.
    Prepare is risk 2 for the AI (a person's OK first); the list is a look-up.
  - The stand-in (`ADDON_CONNECTORS=fake`) keeps envelopes in memory; its page `/test/realestate/esign/:id` sends
    them and plays the signers, and the business hears at once.
  - HandsFreeOS's apps at DocuSign and Dotloop are `ADDON_PLATFORM_KEYS` `realestate.docusign` and
    `realestate.dotloop` (`clientId`, `clientSecret`; DocuSign's `environment: demo` for a developer account), with the
    redirect URI `<WORKER_PUBLIC_URL>/oauth/addon/callback` (docs/operations.md).

- **Step 8:** showings: our page and ShowingTime's emails.

  **As built** (`20261021000700`): `addon_realestate.showings`, and each listing's showing settings (open to requests,
  who confirms, the seller's days and hours, a showing's length, the access instructions, and the hours before and
  after). The seller sees when, who and where it stands, never how to get in or the agent's details.
  - **Our page.** `realestate.public.showing_times` offers the next week's open slots (an hour's notice, none a
    showing already holds); `realestate.public.request_showing` takes one, once per agent while one waits.
    `realestate.portal.showing_answer` is the seller's yes, no or another time; `realestate.showing.decide` is the
    agent's, for them; `realestate.showing.add` books one by hand.
  - **The worker** puts a Home card on the listing agent until it's answered and emails the seller a link to their
    portal; tells the buyer's agent the answer (with the page to pick another time when it's no); sends the access
    instructions to that agent alone `showing_access_hours` before and the feedback link `showing_feedback_hours`
    after (`realestate.showing_access`, `realestate.showing_feedback`, each looking again before it sends). The link's
    token is kept hashed; its page takes one answer (`realestate.public.showing_feedback`).
  - **ShowingTime's emails** (`message.received`, from showingtime.com) are read by their labels into
    `realestate.showing.from_email`: asked for, confirmed, cancelled, feedback, matched to our listing by its address
    and to the showing by ShowingTime's number. Each is marked to check (`realestate.showing.check`); nothing is
    emailed for them, since ShowingTime does its own asking.
  - **What buyers said**: `feedbackSummary` counts showings, answers, average interest and how the price felt; it's on
    Showings and in the price review (`realestate.listing.prices`). Ten minutes after an answer the AI groups buyers'
    words into themes (`realestate.showing_themes`); core keeps only quotes found in what they wrote, and no count above
    the answers. Feedback reaches the seller's portal only once the agent shares it.

- **Step 9:** the vendors directory.

  **As built** (`20261021000800`): `addon_realestate.vendors` (a core company, its services from a fixed list, areas,
  approval, disclosure, note, archived) and `duty_vendors` (a vendor picked on a duty, with the service, quote amount
  and quote document, appointment, and when it was let go and why).
  - `realestate.vendor.save` adds one (a company from Contacts, or a new one through `company.create`; the same name
    is the same company) or changes it; changing an approved vendor's disclosure takes the approval back unless an
    approver changed it. `realestate.vendor.approve` and `.archive` need `realestate.manage`. `.list` counts how often
    deals used each.
  - `realestate.duty.vendors` (its own query beside the duty drawer's) works out the duty's service from its title
    (`serviceForDuty`), or takes the one asked, and offers every approved, unarchived vendor that does it, those whose
    areas are in the home's address first (`inArea`).
  - `realestate.duty.pick_vendor` takes only an approved vendor for a service they do, once per duty, and says their
    disclosure on the deal's timeline. `.vendor_quote` (an amount, and the quote as one of the deal's documents),
    `.vendor_appointment` and `.unpick_vendor` (with a reason; what was kept stays) change it. Each is in the duty's
    own history.
  - Not yet: sharing the list of vendors that fit with the client in their portal; the screens show the agent the
    whole list with each disclosure to give them.

- **Step 10:** the screens (boards 62–75, approved 2026-10-02).

  **As built** (no migration): what the boards needed from the server first (`fec9f3e`): the worker action
  `realestate.feed.search` (the feed asked while the agent types an address or MLS number, nothing kept),
  `realestate.esign.remind` (DocuSign sends it again to whoever hasn't signed), `showingTimeEmails` in the settings
  (ShowingTime's emails read, or left in the Inbox), and `realestate.connections.uses` (what hangs on each
  connection, for when one stops working).
  - **Connections** (boards 62, 63): a core panel any add-on with `connectors` gets
    (`apps/web/src/components/addons/connections.tsx`), shown as Deal settings → Connections, with ShowingTime's
    emails. A sign-in comes back to core's `addons/<id>/connections`, which sends the person to the registry's
    `connections` path.
  - **Listing data** (64–68): From the MLS in Add a home; the MLS on a home's dialog; New matches
    (`deals/<id>/matches`); Comps from the MLS on a CMA; a listing where the MLS and the deal disagree; the MLS's
    photo, price and notice in the portal.
  - **E-sign** (69, 70): Send for signing on Documents, the Signing column and each envelope's panel.
  - **Showings** (71–74): the listing's Showings page and deal card, the public request and feedback pages, and the
    seller's Showings in the portal.
  - **Vendors** (75): Vendors in the menu, and the vendor section in a duty's drawer.
  - Found while building them: a buyer's search waited up to 15 minutes after being turned on, and a changed search
    asked only for what the MLS changed since, missing homes already listed in a new area; now it's asked at once
    (`realestate.search.changed`, and `realestate.buyer_profile.saved` with `searchChanged`) and a changed search
    starts from a first look. The web's address-kept dialogs (`?home=`) lost their address after a refresh; fixed.

- **Step 11:** the docs, the browser test and a short video.

## Not in round five

- Lender, title and insurance connectors (they keep working by upload and email).
- Writing to the MLS (the spec allows it only where the MLS supports it and policy says so).
- Analytics and a brokerage template marketplace.
- Clients searching the feed themselves (a VOW).

# Round six: The phone and the finish

The last round. The spec's §23 has five releases; this round finishes what the earlier ones left for it: the phone's
own deal screens (round one coded every link "as if they exist": the manifest's `ui.phone`, and
`apps/mobile/src/links/addon-screens.ts`, empty until now), deal appointments and portal threads back on the phone,
the spec's field items (B-07: facts, questions, notes, check-in and transcription at a showing; X-24: the walkthrough
checklist; X-41: showing safety), and §18, §21 and §26: brokerage-set retention, legal holds, and a complete
transaction export with a manifest a computer can read.

What the phone had: no Real Estate screen; a sync (`apps/sync/sync-config.yaml`) with no custom records, no
`addon_realestate` tables, no sealed rows, no add-on Home cards and no portal threads; and a queue of changes that knew
no Real Estate command (add-on commands already answer at `/v1/commands/<name>`, so the queue only needs to know them).

## Decisions (Chris, 2026-10-03)

| Question                  | Answer                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which pages on the phone  | **Every page** in `ui.phone` (about 30), drawn by the phone itself. Deal settings stays on the web.                                                               |
| With no signal            | **Fully offline.** Deals and their parts read with no signal; field changes wait on the phone and send later.                                                     |
| People who see every deal | **Their own deals in full; every other deal as its summary, duties and dates.** The rest loads with signal.                                                       |
| Documents                 | **Open with signal.** Names, versions, who signed and what's locked are on the phone; the files stay at HandsFreeOS. Photos taken offline upload later.           |
| Showing safety            | **Check-in with alerts**, built in **core** for everyone (a technician alone in a customer's home needs it too), with Real Estate first.                          |
| An outside safety contact | **Text and email**, from the business's number, never through the shared Inbox, after the contact agrees once by text; STOP is honored.                           |
| Keeping records           | **Keep-for and legal hold.** "Keep closed deals at least N years" (default 7) stops anyone deleting the add-on's data before then; nothing is deleted on its own. |

Chosen for Chris, open to change:

- Real Estate's alerts come to the phone's Home, for the people who see that deal.
- Owners and admins place and lift legal holds (a new core permission, customizable); lifting needs a reason, kept.
  A hold also stops anyone deleting the business.
- Exporting a transaction is a new permission, owners and admins by default.
- An open deal is always kept; an ended one until its end date plus the years set.
- A phone keeps open deals and those ended in the last 90 days.

## How it works

- **An add-on's data reaches the phone without core naming the add-on.** The add-on declares in its manifest which of
  its tables and columns the phone keeps (`offline`), and a core function installs triggers that copy just those
  columns into one core table (`app.addon_phone_rows`). One new sync stream (`records_v1`, beside `business_v1`)
  sends those rows, the add-on's records and the sealed rows that hang on them (tasks, files, appointments, portal
  threads, Home cards) to the people who may see them. Who may see what is kept by triggers as keys and viewer lists,
  because a stream can't ask row security; turning the add-on off takes the keys away, so its rows leave every phone
  without anything being deleted. Changing what the phone keeps later is a migration, not a sync change.
- **Changes with no signal.** Field commands (duty proof and done, notes, photos, tours and feedback, inspections,
  findings, financing steps, contingencies, the walkthrough, check-ins) wait on the phone with an id made there and
  the time they were made. Those that reach a client or another agent ask again after 30 minutes, as texts do. The
  AI, connectors, exceptions, closing a deal, export and holds need signal, and the phone says so before anyone tries.
- **One copy of what each page shows.** Before each group of phone screens, the shaping inside the server's queries
  moves into core view functions that both the server and the phone run, with a test that their answers agree.
- **Showing safety, in core.** A person checks in with a planned end and their own trusted contacts. At the end the
  phone asks "Still there?" (I'm OK, +15 min); ten minutes later each contact gets the place, the planned end, where
  the phone was and how to call: a teammate by an alert to them alone, someone outside by text and email with a page
  that stops the alerts. Only the person and their contacts ever see the place. Help with no signal uses the phone's
  own call and texting apps; HandsFreeOS never calls 911.
- **Holds, in core.** Any add-on's record can be held: a legal hold freezes its files and history; a retention hold
  keeps it until a date. Core refuses to delete an add-on's data while it holds any, and says how many, until when,
  and who can lift a hold.
- **Export.** The worker builds one zip for a deal: every document and version with its fingerprint checked, the
  deal, terms, duties and their proof, approvals with who and why, contingencies, offers, inspections, financing,
  showings, vendors, messages, history and audit, and `manifest.json`. It's kept on the deal's Documents.

## Build order (round six)

Round six's migrations follow round five's, from `20261022000100`. The sync change can't reach `main` before rounds
two to six's migrations are on the hosted database (Chris's OK). Phone screens wait for Chris to approve the boards;
the server steps go ahead meanwhile.

- **Step 0:** this part, and boards 76–93 in `design/realestate`, in the phone app's own look.
- **Step 1:** a check that PowerSync 1.26.1 filters a key lookup together with a viewer list, and how many buckets an
  owner with 300 deals takes.
- **Step 2 (core):** keys and seal columns kept by triggers, the team cascade, Home cards' viewers.
- **Step 3 (core):** `app.addon_phone_rows`, the manifest's `offline`, purging and verifying, the phone's contract.
- **Step 4 (core):** record holds, and deleting an add-on's data refused while it holds any.
- **Step 5 (core):** check-ins: contacts, check-ins and their commands.
- **Step 6 (sync):** the one batched change: `records_v1`, its tests and scenarios, and the phone subscribing to it.
- **Step 7:** Real Estate's offline tables, the window, retention holds, field notes, the walkthrough's tables,
  exports, and each command's offline class.
- **Step 8 (core worker):** a stored recording turned into words, for field notes.
- **Step 9:** the walkthrough's list, from the contract, repairs, findings and condition photos (X-24).
- **Step 10:** the transaction export.
- **Step 11 (core):** the safety ladder, the push with its buttons, texting a contact, the contact's page, Settings →
  Safety.
- **Step 12 (phone):** Real Estate in More, the gate, Needs signal, portal threads with a reply that goes back to the
  portal, a deal's appointments, Home cards, safety screens (a store build: new location and microphone wording).
- **Steps 13–18 (phone screens):** deals, duties, Coordinate and vendors; a deal and its duty, dates, contingencies,
  contract, documents, history and client update; the buyer's pages; financing, inspections, the client's to-do and
  the walkthrough; the listing's pages and showings; safety, holds and export on both apps.
- **Step 19:** a phone flow (Maestro), the browser test for the web parts, the docs and a video.

## Not in round six

- Location in the background (only at check-in and Help).
- Smart lockboxes.
- Keeping documents on the phone.
- The AI teammate using add-on tools.
