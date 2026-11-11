# Contractor Operations

An add-on (`contractor`) for contractors and home service companies: electricians, plumbers, HVAC, roofers,
remodelers and general contractors. One shared engine runs jobs and projects, estimates with costs, and crews, work
orders and dispatch, and later materials, job costing and a field app, with trade tools inside it after that.

The owner's decisions and the build order are in `HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md`; the
numbers below (decision 1, and so on) are its decisions. Built: part 1, jobs and projects; part 2, costs and
estimates; and part 3, crews, work orders and dispatch. The add-on is in `development`, offered to nobody; staff give
it to a business from Admin → Businesses.

## Where things are

| What                                                           | Where                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The manifest: permissions, kinds of records, events, menu      | `packages/core/src/addons/contractor/manifest.ts`                      |
| The tables (and their Drizzle mirror)                          | `supabase/migrations/20261027024000_addon_contractor.sql`, `tables.ts` |
| Part 2's tables: costs, estimates, OKs                         | `supabase/migrations/20261027024200_contractor_estimates.sql`          |
| Part 3's tables: crews, work orders, checklists, subs          | `supabase/migrations/20261027024300_contractor_work_orders.sql`        |
| Trades and their starter phases                                | `trades.ts` (pure; web, phone and server all use it)                   |
| Statuses, % done, lateness and planned profit                  | `progress.ts` (pure)                                                   |
| The pages' words, and every refusal's                          | `words.ts`                                                             |
| Shapes and limits                                              | `schemas.ts`                                                           |
| Jobs and properties: open, change, status, team, budget        | `ops/jobs.ts`                                                          |
| Phases                                                         | `ops/phases.ts`                                                        |
| Cost, markup, margin and the lowest-margin check               | `estimating.ts` (pure; the builder and the server both use it)         |
| Item costs, how the business estimates, and the builder        | `ops/estimates.ts`                                                     |
| Starter checklists, and what holds a job's Done                | `checklists.ts` (pure)                                                 |
| Crews                                                          | `ops/crews.ts`                                                         |
| A visit and its work order                                     | `ops/visits.ts`, `ops/work-orders.ts`                                  |
| Dispatch                                                       | `ops/dispatch.ts`                                                      |
| Reading: overview, jobs, one job, properties                   | `ops/queries.ts`                                                       |
| What it shares (loading a job, keeping % done, timelines)      | `ops/common.ts`                                                        |
| Where the Assistant finds each page                            | `ai-places.ts`                                                         |
| The worker: visits, work orders, approved estimates, OK alerts | `apps/worker/src/addons/contractor/`                                   |
| The web pages                                                  | `apps/web/src/addons/contractor/`, routes under `a/contractor/`        |
| The Assistant's checklist for its screens                      | `packages/core/src/assistant/ledger/contractor.json`                   |

## How it works

- **A job is a record.** Each job is a record of the add-on's kind `contractor_job`, with one row in
  `addon_contractor.jobs` for what a record doesn't hold: kind, status (and why), trade, the work to do, start day,
  deadline, when it was done, % done and its lead. Core's record page is its Notes, files and tasks; search, the
  timeline and the Deleted bin work on it unchanged.
- **Every job is at a property** (decision 3). A property is a record of kind `contractor_property` named by its
  address. A job is tied to its customer (`contractor_customer`, person → job) and its property (`contractor_site`,
  job → property); a customer owns their properties (`contractor_owner`). New job takes one of the business's
  properties (the customer's first) or a new address, which becomes a property owned by the customer.
- **Service call or project** (decision 2). A job starts as a service call, or as a project with the business's
  starter phases. Adding the first phase, or **Make it a project**, makes a service call a project. The starter
  phases are the business's own list (Settings), else the job's trade's, else its first trade's, else Plan, Do the
  work, Final walkthrough (`phasesForNewProject`).
- **Statuses.** New, Scheduled, In progress, On hold, Done and Cancelled. On hold and Cancelled need a reason, shown
  on the job and its card. Done sets 100% and when it was done; a done or cancelled job is read-only until it's moved
  back. Done waits on the required items of its visits' checklists ("Crews and work orders" below).
- **% done.** A project with phases is the average of its phases' % done, kept by the server on every change
  (`keepPercent`). A service call's is set by hand. A phase's status and % move together: Done is 100%, Not started
  is 0%, and Started stays under 100%.
- **Visits.** Book a visit books a normal HandsFreeOS appointment for the job's record (`custom_record_id`), with
  its customer filled in. When one is booked, a new job moves to Scheduled; when its crew presses Started, a new or
  scheduled job moves to In progress. Neither ever moves a job backwards, or one that's on hold, done or cancelled.
  Each visit on a job has a work order ("Crews and work orders" below).
- **Budget and price** (decision 11). Each job's price to the customer, labor, materials, other costs and labor
  hours live in `addon_contractor.money`, which row security keeps to `contractor.costs` (owners and admins by
  default). The job page shows the budget, the planned profit and the margin (in red under 20%, decision 6). Amounts
  stay off events and the timeline.
- **The team.** A job has one lead (anyone can lead their own; someone else takes `records.assign`) and up to 20
  others on its team. **My jobs** is the jobs someone leads or is on.
- **Late.** A job or phase past its deadline and not finished is late, by the business's time zone.
- **Settings** (decision 1). The trades the business does, the phases a new project starts with and the checklist
  a new visit starts with, saved by core's `addon.save_settings` against the manifest's settings shape. A save
  replaces all three, so the page always sends them together. Estimating and Crews are cards of their own there.

## Costs and estimates

Part 2. The builder writes an **ordinary HandsFreeOS estimate** through core's own commands, so its number, its
link, the customer's page, its invoice and its payments are all core's. The add-on keeps only what core can't see:
the job it's for, what each line costs, and an owner's or admin's OK.

- **Item costs.** Each price list item (Settings → Products) can have a cost and a kind: labor (by the hour),
  material or other (`addon_contractor.item_costs`). Until someone says, a service is labor, a fee is other and the
  rest is material (`defaultCostKind`). The Item costs page sets them; the builder fills a line's cost from them.
- **How the business estimates** (`addon_contractor.estimating`, Settings → Estimating): its lowest margin (20% to
  start), the markup a new line starts with (50%), and what an hour of labor sells for and costs. Only people with
  `contractor.approve` change it.
- **The builder** (`a/contractor/estimates/new`, `…/estimates/<id>`). Each line is labor, a material or other, with
  how many, what one costs, a markup and a price; changing the cost or the markup sets the price, and changing the
  price shows the markup it works out to. Add labor adds hours at the business's hourly price and cost. It shows
  the open option's price before tax, labor, materials, other, cost, profit and margin as someone types, with the
  same math the server uses (`costOption`, `checkMargin`).
- **Good, better, best** (decision 5) is core's: one estimate with up to three options, and the customer picks one
  when they approve ("Good, better, best" in `docs/operations.md`). The builder costs each option on its own.
- **Margin.** An option's margin is its profit over its price before tax and after any discount: tax is the
  state's, not the business's. A 50% markup is a 33% margin; the page shows both so nobody mixes them up.
- **The lowest margin and its OK** (decision 6). An estimate waits for an owner or admin when any option is under
  the lowest margin, or when a labor or material line has no cost (so the margin can't be trusted). Every option
  counts, since the customer may pick any. **Ask for an OK** tells everyone with `contractor.approve` on Home and
  their phones; **OK it** lets it go out, with an optional note. The OK is for the estimate exactly as it stood
  (`estimate_oks.revision` is core's revision): any later save needs a fresh one. `contractor.estimate.send` refuses
  with `contractor_margin_needs_ok` until then, for everyone, including the people who may OK it.
- **Nobody walks around the check.** Core stamps an estimate the builder wrote with `addon_id = 'contractor'`, and
  refuses to change or send it from Money, the phone or the Assistant's core tools while the add-on runs
  (`estimate_built_elsewhere`). With the add-on off or gone it's an estimate like any other. Money's estimate page
  shows a notice on such a draft, and the add-on's panel (`estimate.panels`) shows its costs to people who may see
  them, with a link back to the builder.
- **Once it's sent** it's core's document. The builder's page turns read-only: each option's costs and margin, and
  the one they picked.
- **An approved estimate fills its job's budget.** On `estimate.accepted` the worker runs
  `contractor.estimate.fill_job`: the job's price, labor, materials, other costs and labor hours become the sum of
  every approved estimate on that job, each at the option the customer picked. A second approved estimate adds to
  the first.
- **Who sees what** (decision 11). Item costs, how the business estimates and each estimate's costs are read only
  with `contractor.costs`, by row security. Someone on a job without it sees that the job has an estimate, its
  status and its total where Money would show them the estimate (they're on its customer, or manage money), and
  none of what it costs. Core's own rule stands in the builder too: someone who bills without managing money
  writes estimates only for the customers they're on (`money_not_your_customer`).

## Crews and work orders

Part 3. A visit on a job is an **ordinary HandsFreeOS appointment** whose record is the job, so its time, its
people, its reminders and its status buttons are core's. The add-on keeps beside it what core doesn't: crews, and
the visit's work order.

- **Crews** (decision 7). A crew is a named group of people on the business's team and subcontractors (`crews`,
  `crew_members`). Settings → Crews makes and changes them, with `contractor.manage`; everyone with `contractor.use`
  sees them. A business keeps up to 50, with up to 30 people and 30 subcontractors in each. A crew that's no longer
  used is archived, never deleted, so the visits it worked still say its name; it can be brought back.
- **A subcontractor is a contact.** They don't sign in. For a subcontracting company, it's the person the business
  deals with there, and Contacts says which company. They're texted the job's details, and the office marks their
  work done. Their insurance and payments come in Phase 2.
- **A work order** (`work_orders`, one per visit on a job): instructions, what to bring, the crew it was given to,
  its subcontractors (`work_order_subs`) and its checklist (`work_order_items`). The worker starts one when a visit
  is booked on a job (`appointment.booked` runs `contractor.work_order.start`). Changing one starts it too, so a
  visit booked before the add-on was on gets its work order the first time someone uses it; only reading one never
  writes. Its page is `a/contractor/visits/<the appointment's id>`. The job's Visits list and Dispatch open it, and
  booking a visit from the job's page opens it straight away.
- **Who's going.** The people on the team are the visit's own (core's `appointment_staff`). Putting a crew on a
  visit (`contractor.work_order.set_crew`) books everyone in it through core's `appointment.reassign`, in place of
  whoever was on it, and adds the crew's subcontractors to the work order. Core's checks apply: when someone in the
  crew is busy, off or outside their hours then, the page says why and asks before putting them on anyway, and
  someone who already has an appointment then stops it, since core never books one person twice (`slot_taken`). The
  customer isn't texted about who's coming. Taking the crew off takes only its name off; the people stay.
- **The checklist.** An item is a box to tick or a photo to add, and may be required; a work order holds up to 40.
  A new one starts with the business's own list (Settings → Checklist for a new visit), else its job's trade's
  starter checklist, else the business's first trade's, else a plain three (`checklistForNewVisit`). Anyone who uses
  the add-on adds, changes, removes and ticks items. A photo item is done by adding a photo, kept as one of the
  job's files; deleting that file later leaves the item done.
- **Done waits on the required items** (decision 8). `contractor.job.set_status` refuses Done with
  `contractor_job_not_ready` while a required item is left on any of the job's visits, and says what's left, by
  visit. A cancelled visit's items don't count, and neither do those of a visit in the Deleted bin. Someone with
  `contractor.skip_checks` (owners and admins to start) can mark it done anyway with a reason, which is kept on each
  item it passed over and on the job's timeline. Without that permission it's `contractor_skip_not_allowed`.
- **Only the job's Done is held.** A visit's own Done button, on the phone and the calendar, is core's and isn't
  held: a crew can finish a visit with items left, and the job still can't be closed until they're done or skipped.
- **Texting the details** (`contractor.work_order.tell_subs`) goes through core's `message.send`: the job, the
  address, when, the instructions, what to bring and a line of the sender's own. Consent, texting setup and quiet
  hours are core's. It answers who was texted and who couldn't be, with why (no mobile number, opted out). In quiet
  hours nobody is texted, and the person is asked once whether to send to everyone anyway.
- **A work order changes only while its job is open.** A cancelled visit's, or one on a job that's done or
  cancelled, is read-only (`contractor_visit_cancelled`, `contractor_job_closed`) until the job is moved back.
- **The job's timeline** gets a line for a crew put on a visit, a subcontractor added or marked done, the details
  texted, and a job marked done with items left (with the reason). Ticking a box doesn't write one; every change is
  still an event filed under the job.

## Dispatch

`a/contractor/dispatch` (`contractor.dispatch`), for everyone with `contractor.use`. It shows one day at a time, in
the business's time zone, today to start:

- **The day's visits on jobs, in a column per person** on them, the person looking first. Each visit shows its
  time, where it stands, its job, customer and property, its crew, how many of its subcontractors are done and its
  checklist's progress, and opens its work order.
- **Nobody on it yet:** the day's visits with no one booked on them.
- **Needs a visit:** jobs that are new, scheduled or in progress with nothing booked from now on.

Where a visit stands is core's job status for it, which its crew presses on the phone or the calendar: scheduled, on
the way, started, waiting on parts, done. Cancelled visits aren't shown, and neither are visits in the Deleted bin.
A day answers up to 300 visits. Moving a visit or changing its time is the Calendar's; Dispatch only reads.

## Rules worth knowing before changing anything

- **One add-on for every trade** (decision 1). A trade brings its starter lists; it never becomes its own add-on. New
  trades go in `TRADES`, with their names, words and starter phases.
- **One Job for service calls and projects** (decision 2). Never two kinds of page: a project is a job with phases.
- **Every job is at a property tied to its customer** (decision 3), through relationships, never an address field on
  the job.
- **Costs and profit only for `contractor.costs`** (decision 11), held by the database: the `money` table's row
  security, not only the screens. A query answers `money: null` for everyone else, and no event, timeline line or
  AI outcome carries an amount.
- **The server keeps % done; screens only show it.** A project's % is never set by hand
  (`contractor_percent_on_project`).
- **The AI prepares and a person approves** for safety, code compliance, contracts and significant spending (the
  owner's rule). In part 1: starting a job, changing it, its status, making it a project, its budget and removing a
  phase wait on a Confirm card; look-ups, phases, % done and the team run on their own. In part 2 every change
  waits on a Confirm card: writing an estimate, asking for an OK, giving one, sending, an item's cost and how the
  business estimates. The Assistant acts as the person asking, so it can only OK an estimate for someone who may.
  In part 3, ticking or changing a checklist item, removing one, putting a crew on a visit, marking a
  subcontractor's work, taking one off, texting the details and archiving a crew wait on a Confirm card; look-ups,
  starting a work order, its instructions, adding an item or a subcontractor and saving a crew run on their own.
  Marking a job done with items left needs its reason on the same Confirm card as the status.
- **An estimate is core's; the add-on never copies one.** The builder saves through `estimate.create`,
  `estimate.update` and `estimate.send` (`executeCommandWithin`), so core's rules, numbering and totals apply
  unchanged. Never write to `app.estimates` or `app.estimate_lines` from the add-on.
- **An estimate under the lowest margin never goes out without an owner's or admin's OK** (decision 6), and the
  server decides, not the screen. An OK stands only for the revision it was given on. Raising the lowest margin
  later doesn't undo an OK already given.
- **Costs stay off events, timelines and AI outcomes** (decision 11). `contractor.estimate.*` events carry ids, how
  many options and why an OK is needed, never an amount or a cost. Labor's cost per hour stays out of history too;
  the lowest margin is a rule, so history shows how it moved.
- **A line's cost is kept by option and place** (`estimate_costs`: option 1 to 3, line from 0), rewritten whole on
  every save, because core rewrites an estimate's lines whole. Read costs through `contractor.estimate.get`.
- **A visit is core's appointment; the add-on never copies one.** Who's on it changes only through
  `appointment.reassign`, and a text to a subcontractor only through `message.send` (`executeCommandWithin`), so
  core's checks, consent and quiet hours apply unchanged. Never write to `app.appointments`,
  `app.appointment_staff` or `app.messages` from the add-on.
- **A job is never marked Done with a required item left, unless someone who may skip says why** (decision 8), and
  the server decides, not the screen. The reason stays on each item it passed over.
- **A subcontractor is a contact and never signs in** (decision 7). Nothing gives them a login or a page; the
  office marks their work.
- **A crew is archived, never deleted,** so past visits keep its name.
- **Archiving and deleting go through core.** The add-on never deletes a job's record itself. What it does delete
  is small and its own: a phase, a checklist item, a subcontractor taken off a visit, and a crew's member list when
  the crew is saved. The Assistant asks first for the first three.
- **Every screen item is in the Assistant's checklist,** and every person-run operation declares `ai`.

## Not yet

- Parts 4 to 7: materials, time and job costing, the phone's pages, and the AI helpers. See the plan.
- An approved estimate fills its job's budget; filling the job's materials list comes with materials in part 4.
- An estimate the AI drafts on its own always waits for a person (decision 6): that comes with the AI helpers in
  part 7. Today the Assistant writes an estimate only as the person asking, on a Confirm card.
- The builder is on the web. On the phone, Money won't send such a draft and says to open it in Contractor
  Operations; the add-on's phone pages are part 6.
- Panels on a customer's or a property's page: Contacts lists jobs and properties as their own kinds already.
- A work order's **materials to bring** is a note for now (What to bring); the job's materials list, and what's
  missing for each visit, is part 4.
- Booking a crew in one step from the booking dialog: today a visit is booked with core's dialog, then its work
  order opens and the crew is picked there.
- Work orders, checklists and photos on the phone, with no signal: part 6. Until then the phone shows the visit as
  the appointment it is, and the web has its work order.
- Dragging a visit to another person or time on Dispatch: it reads only, and the Calendar moves visits.
- A subcontractor's insurance and payments, and a page of their own to mark work done: Phase 2.
