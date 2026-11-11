# Contractor Operations: implementation plan

The owner's ask (2026-11-10): one shared add-on for contractors and home service companies (electricians, plumbers,
HVAC, roofers, remodelers and general contractors) that runs jobs, projects, estimates, crews, materials, job costing
and a field app, with trade tools later and the AI teammate doing the admin work. It supports both quick service calls
and long projects.

The owner's rule for the AI: **"For anything involving safety, code compliance, contracts, or significant spending,
the AI should prepare and recommend actions while authorized humans retain approval."**

How it works, and the rules worth knowing before changing anything: `docs/contractor.md`.

## The owner's decisions (2026-11-10, 14:35 UTC: "all your picks")

1. **One add-on, "Contractor Operations", for every trade.** Each business picks its trades in its settings, which
   load starter lists for that trade (phases in part 1; checklists, materials and estimate templates in later parts).
   Deeper trade tools come later inside it. One install, one side-menu row.
2. **One "Job" for both service calls and projects.** It starts as a service call; add phases and it becomes a
   project. Same customer, estimate, materials and invoice either way.
3. **Every job is at a Property** the customer owns, so each property keeps every job for good. One customer can have
   many properties.
4. **Estimates build on HandsFreeOS's estimates,** with costs, markup, profit and margin behind them. The customer
   sees the same estimate page they see today.
5. **Good, better, best options in Phase 1:** up to 3 on one estimate, and the customer picks one when they accept
   online. Built in core's estimates, so every business gets it.
6. **A lowest margin (20% to start).** An estimate under it waits for an owner or admin to OK it before it's sent. An
   estimate the AI drafts always waits for a person.
7. **Crews are named groups of team members and subcontractors.** Booking a crew books everyone on the visit.
   Subcontractors are contacts or companies, get a text with the job's details, don't sign in, and the office marks
   their work. Their insurance and payments come in Phase 2.
8. **A job can't be marked Done until its required checklist items and photos are done.** An owner or admin can skip
   that with a reason.
9. **Materials per job only in Phase 1** (needed, ordered, delivered, used, wasted, returned). Stock in warehouses
   and vans, and supplier orders, come in Phase 2.
10. **Time from the buttons techs already tap:** On the way starts travel time, Started starts work time, Waiting on
    parts or Done stops it, plus a Break button. Each person's cost per hour turns hours into labor cost. Fixing a
    time takes an owner or admin.
11. **Owners, admins and anyone given "See job costs and profit" see costs and profit.** Techs see their work, not
    the money.

## Phase 1, in parts (each ships on its own)

1. **Jobs and projects.** _Built._ The add-on, one side-menu row (Jobs, with Settings popping out). A job
   is a record of the add-on's kind, at a property (another of its kinds) tied to its customer. A service call, or a
   project with phases, deadlines, % done and a planned budget. Jobs page (board by status and a list; All, My jobs,
   Late; search; done and cancelled on a tick), a page for each job, and Settings (trades, a new project's phases).
   Visits booked or started on a job move it along. The Assistant can do all of it.
2. **Costs and estimates.** _Built._ A cost on each price list
   item; an estimate builder with labor (hours × rate), materials
   at cost, markup, profit and margin, making a normal HandsFreeOS estimate; good, better, best options in core's
   estimates (decision 5); the lowest margin and its OK (decision 6). An accepted estimate fills the job's budget and
   its materials list (the list came with part 4).
3. **Crews, scheduling and work orders.** _Built._ Crews
   (decision 7), booked from the job; a work order on each visit (instructions, checklist, materials to bring, who's
   going, photos required); starter checklists per trade; Done waits on the required items (decision 8); one dispatch
   screen.
4. **Materials.** _Built._ Per job (decision 9), with what's
   missing for each upcoming visit and an alert before it.
5. **Time and job costing.** _Built._ Time from the status buttons
   (decision 10), each person's cost per hour, estimate against actual, the profit it's heading for, and a profit
   dashboard by job, crew, service and customer.
6. **The phone field app.** _Built._ Jobs, work orders, checklists, photos, materials used, time and voice notes,
   all with no signal.
7. **AI helpers.** Draft an estimate from notes, photos and measurements; warn when a job heads over budget, with the
   new profit; turn a tech's voice notes and photos into a daily job report. Each waits for a person where the
   owner's rule says so.

## Phase 2 and 3 (the owner's list, after Phase 1)

- **Phase 2:** stock in warehouses and vans, purchase orders and suppliers, supplier integrations, the AI project
  manager and dispatcher, the customer project portal, time tracking and payroll, change orders and progress
  payments, subcontractors' insurance and payments.
- **Phase 3:** trade tools (electrical, plumbing, roofing, construction), advanced AI forecasting, equipment and
  fleet.

## Part 1 as built

- **Data.** `supabase/migrations/20261027024000_addon_contractor.sql`: the add-on's three permissions, and its tables
  in `addon_contractor`: `jobs` (one row per job record: kind, status and why, trade, work to do, start, deadline,
  done, % done, lead), `phases`, `team` and `money` (price and budget, read and written only with
  `contractor.costs`). Drizzle mirror in `packages/core/src/addons/contractor/tables.ts`.
- **Records.** Kinds `contractor_job` and `contractor_property`; relationships `contractor_customer` (person → job),
  `contractor_owner` (person → property) and `contractor_site` (job → property). Notes, files, tasks, the timeline
  and search work on them unchanged.
- **Operations.** 14 commands and 4 queries in `packages/core/src/addons/contractor/ops/`, every person-run one with
  `ai`. Removing a phase asks first; a new job asks first (it can add a property and tie a customer).
- **Worker.** `apps/worker/src/addons/contractor/`: a visit booked on a job moves a new job to Scheduled, and a visit
  started moves it to In progress (`contractor.job.follow_visit`).
- **Web.** `apps/web/src/addons/contractor/`, routes under `a/contractor/`.
- **Assistant's checklist.** `packages/core/src/assistant/ledger/contractor.json`.
- **Not in part 1:** record panels on a customer's or property's page (Contacts lists jobs and properties as their
  own kinds already), the phone's pages (part 6), deleting a job's data (it's archived through core).

## Part 2 as built

- **Core: good, better, best** (decision 5). `supabase/migrations/20261027024100_estimate_options.sql` adds
  `options`, `option_position` and `addon_id` to `app.estimates`. One estimate offers up to three options; the
  customer picks one on their page when they approve, or the team says which when it records a yes. Money's editor,
  the estimate page, the customer's page and the Assistant's `write_estimate` and `manage_estimate` all know them.
  "Good, better, best" in `docs/operations.md`.
- **Core: an estimate an add-on builds.** `app.estimates.addon_id` names the add-on whose builder wrote it. While
  that add-on runs, core changes and sends the estimate only from it (`estimate_built_elsewhere`), and Money's
  estimate page has a place for its panel (`estimate.panels`).
- **Data.** `supabase/migrations/20261027024200_contractor_estimates.sql`: the permission `contractor.approve`
  (owners and admins), and `estimating` (lowest margin, starting markup, labor's price and cost per hour),
  `item_costs`, `estimates` (the job an estimate is for, and who asked for an OK), `estimate_costs` (each line's
  kind and cost) and `estimate_oks` (who OK'd which revision). Costs are read only with `contractor.costs`.
- **Operations.** Seven commands and three queries in `ops/estimates.ts`: save, ask for an OK, OK, send, set how
  the business estimates, set an item's cost, and the worker's fill-the-job; the builder's read, the list and the
  item costs. The math is pure, in `estimating.ts`.
- **Worker.** `estimate.accepted` fills the job's price and budget; an ask raises a Home alert for people who may
  OK it, cleared when it's OK'd, sent, voided or saved with nothing left to OK.
- **Web.** Estimates (all, or waiting for an OK), the builder, Item costs, an Estimating card in Settings, an
  Estimates card on the job, a waiting notice on Jobs, and the Costs and profit panel on Money's estimate page.
- **Left for later parts.** The job's materials list from an approved estimate (part 4). Estimate against actual
  (part 5). A builder on the phone (not in Phase 1: part 6 kept estimates on the web). An estimate the AI drafts on
  its own, which always waits for a person (part 7).
- **Choices made while building.** An OK stands when the lowest margin is raised afterwards. Whoever may OK an
  estimate still has to OK it before sending, so nothing goes out unchecked by a slip. A line with no cost counts
  as unchecked only for labor and materials; a permit or a fee with no cost is fine.

## Part 3 as built

- **Data.** `supabase/migrations/20261027024300_contractor_work_orders.sql`: the permission `contractor.skip_checks`
  (owners and admins), and `crews`, `crew_members`, `work_orders` (one per visit on a job: instructions, what to
  bring, its crew), `work_order_items` (the checklist) and `work_order_subs` (the subcontractors on a visit: when
  they were texted, when their work was marked done). Core's appointment stays the visit; nothing in core points at
  these.
- **Operations.** 13 commands and 3 queries: crews (`ops/crews.ts`: save, archive, list), work orders
  (`ops/work-orders.ts`: start, update, set the crew, add, remove, mark and text subcontractors, add, change, remove
  and tick checklist items, and read one) and Dispatch (`ops/dispatch.ts`). The Done check is in
  `contractor.job.set_status` (`ops/jobs.ts`). The checklist's rules are pure, in `checklists.ts`.
- **Worker.** A visit booked on a job starts its work order, then moves the job along as before.
- **Web.** A visit's work order page, Dispatch (a second row popping out of the add-on's menu row), Crews and
  Checklist for a new visit in Settings, and on the job: each visit's stage, crew and checklist progress, and a
  dialog saying what's left when Done is refused, with the skip for people who may.
- **Left for later parts.** The job's materials on a work order (part 4). Time from the status buttons (part 5).
  The phone's work orders, checklists and photos (part 6).
- **Choices made while building.**
  - A subcontractor is always a contact. For a company, it's the person the business deals with there, since a
    text and a "done" need a person.
  - Decision 8 holds the job's Done, not a visit's own Done button, which is core's.
  - Skipping needs its own permission, `contractor.skip_checks`, so a business can give it to a lead without making
    them an admin.
  - A visit is booked with core's own dialog (one person), then its work order opens and the crew is picked there;
    putting a crew on replaces who was on the visit.
  - Crews are set up by people who manage the add-on (`contractor.manage`); anyone who uses it puts one on a visit.
  - A cancelled visit's required items never hold its job.

## Part 4 as built

- **Data.** `supabase/migrations/20261027024400_contractor_materials.sql`: `materials` (one row per material on a
  job: its name, what it's counted in, the price list item and the visit it's for, if any, the six counts, its
  supplier, when it's expected, a note, and the estimate line it came from) and `material_costs` (what one costs,
  readable only with `contractor.costs`). The add-on's settings gain `materialsAlertHours`. No new permission.
- **Operations.** 5 commands and 1 query in `ops/materials.ts`: list, add, change, remove, set a cost, and the
  system's own cost stamp. `contractor.estimate.fill_job` now puts an approved estimate's material lines on the
  job. A job's visits, Dispatch and a work order each say what's missing. The rules are pure, in `materials.ts`.
- **Worker.** `contractor.materials_check`, one queued job per visit, raises and clears the missing-materials
  alert. It's armed when a visit is booked or moved, run again when the job's materials change, and taken down when
  the visit is cancelled or over. The worker also fills in a price list item's cost for someone who couldn't see it.
- **Web.** A Materials card on the job's page and on each visit's work order (the visit's own, with no costs), the
  missing count on the job's visits and on Dispatch, and Missing materials in Settings.
- **Left for later parts.** Actual material cost against the budget (part 5). Materials used from the phone, with
  no signal (part 6). Stock, suppliers and purchase orders (Phase 2).
- **Choices made while building.**
  - Each count is the total so far, and where a material stands is worked out from the counts, never stored.
  - A material is for one visit or for any. What a visit is missing counts both.
  - Adding a material and changing its counts run on their own for the AI: they record what happened and order
    nothing, so no money moves. Taking one off and setting a cost wait on a Confirm card.
  - Costs live in their own table so the database, not the screen, keeps them to people who may see job costs.
    The worker stamps a price list item's cost when the person adding it couldn't see it, so costing stays whole.
  - Picking from the price list needs core's `money.read`, since the price list is core's. Everyone else types a
    name.
  - The alert goes to the job's lead and the people on the visit, a day before to start. A business picks 2 hours,
    1, 2 or 3 days, a week, or never.
  - An approved estimate's material lines are added once each, so a retry never doubles the list.

## Part 5 as built

- **Data.** `supabase/migrations/20261027024500_contractor_time.sql`: `time_entries` (one stretch of one person's
  travel, work or break on a job, with the visit it was on and who fixed it and why), `time_costs` (what an hour of
  a stretch cost), `labor_rates` (what an hour of each person costs) and `other_costs` (a permit, a fee, a
  subcontractor's bill). The last three are readable only with `contractor.costs`. One new permission,
  `contractor.fix_time`, for owners and admins.
- **Operations.** 10 commands and 4 queries in `ops/time.ts` and `ops/costing.ts`: the time on a job, taking a
  break, fixing, adding and removing time, what an hour of each person costs, a job's costing, its other costs, and
  profit across jobs; plus the system's own three (follow a visit's status, stamp costs, stop time left running).
  The rules are pure, in `time.ts` and `job-costing.ts`.
- **Worker.** Core's `job.status_changed` and `appointment.cancelled` on a visit start and stop time. A queued job
  per visit, `contractor.time_check`, stops time left running 12 hours and raises the alert for people who may fix
  time. Costs are stamped after a break, a fix, added time, and a change to someone's cost per hour or to
  Estimating's labor cost.
- **Web.** A Time card on the job's page and on each visit's work order, a Costs so far card on the job's page, a
  Profit page in the menu, and What an hour costs you in Settings. The last three show only to people who may see
  job costs.
- **Left for later parts.** The Break button and time on the phone's own pages (part 6). A warning sent when a job
  heads over budget (part 7). Payroll, pay rates and overtime (Phase 2).
- **Choices made while building.**
  - Time is per person, in stretches of travel, work and break. The buttons start it for everyone on the visit, at
    the moment pressed, or for whoever pressed it when nobody is on the visit.
  - One clock per person in a business. Starting on another visit stops the first.
  - News heard twice or late changes nothing. Only the buttons' own stretches count as proof it's old, and a stop
    never lands before its stretch started.
  - Break pauses only work time, for oneself. Someone else's takes the fix permission.
  - A stretch left running 12 hours is stopped there, marked, and the people who may fix time are told. The alert
    stays until someone has looked.
  - Fixing, adding and removing need a reason, kept on the stretch and the timeline. They're allowed on a done job
    and can't overlap the same person's other time.
  - What an hour cost is stamped for each stretch by the system when the time is tracked: the person's own cost
    per hour, else Estimating's labor cost. A later raise never changes past jobs. Seeing costs takes
    `contractor.costs`; setting one takes `contractor.approve`.
  - Other costs are added and removed, never edited.
  - Heading for: labor is paced by the job's % done from 10% along; materials and other costs head for the larger
    of the plan and what's spent; a finished job heads for what it cost.
  - Profit counts done jobs by the day they were marked Done in the business's time zone, in whole calendar
    months, quarters and years, or open jobs at what they're heading for. The price is the job's budget price; none
    counts as $0. Service is the job's trade, and a job counts for the crew on most of its visits.
  - For the AI, a break runs on its own. Every other change to time, a cost per hour or a job's other costs waits
    on a Confirm card.
  - Costs stay off events, timelines and AI outcomes.

## Part 6 as built

- **Data.** `supabase/migrations/20261027025300_contractor_on_the_phone.sql`: one new table, `notes` (a note from
  the field on a job or one of its visits: typed, a recording with its words, or photos), an `id` on `team`, and
  what phones keep. Phones keep each job with its phases, team, work orders, checklists, subcontractors, materials,
  time and notes, and the business's crews. They keep no money (decision 11). Nothing changed in
  `apps/sync/sync-config.yaml`: the rows travel the way Real Estate's do.
- **Operations.** 3 new commands and 1 query: counting a material (`contractor.material.count`), and adding,
  taking off and listing notes; plus the system's own (`contractor.note.transcribed`). Six commands may wait on a
  phone with no signal: a tick, a count, a break, a note, a phase's status and a service call's % done. The phone's
  views are pure, in `views/phone.ts`, and a test holds them to the server's answers.
- **Worker.** A voice note's recording is put into words by the transcriber calls use, and billed the same way, as
  speech. A job that closes leaves phones a month later (a queued job per job, `contractor.phone_check`), and
  comes back when it's opened again.
- **Phone.** A Jobs row in More. Jobs (my visits today, then my jobs, all or late, with a search), a job (status,
  customer with Call, progress, visits, materials, time, notes), and a visit's work order (when and where with
  Directions, the visit's status buttons, instructions, checklist with photos, materials, time with the break
  button, notes). A visit on a job also has a Work order row on its page in Calendar.
- **Web.** A Notes from the field card on the job's page and on each visit's work order, where the office reads
  what the crew left and can type a note.
- **Left for later.** On the phone: starting a job, booking a visit, dispatch, estimates, costs and settings;
  adding or changing materials, checklist items, crews and subcontractors; fixing time; marking a job done anyway;
  looking at a note's photos and playing its recording. A daily report made from the notes and photos (part 7).
- **Choices made while building.**
  - Everyone who uses the add-on gets every job on their phone, so a tech can cover a visit that isn't theirs.
  - A done or cancelled job stays on phones 30 days, then leaves with everything on it.
  - Work done with no signal counts from when it was done. A tick or a count made while the job was open still
    lands after the office closed it.
  - A count from the phone adds to what's counted, so two people counting both add up. It can take some back, never
    under nothing.
  - A job's status needs signal, because Done is checked against every visit's checklist. So does taking a note
    off.
  - A note is typed, spoken or photographed, and never edited. People take off their own; owners and admins take
    off anyone's. Its photos and recording stay in the job's files.
  - A finished job still takes notes, for a callback or something the customer said afterwards.
  - With no Deepgram key a voice note gets no words: the note keeps its recording, and the app says to play it.
  - The phone shows hours and never money.
