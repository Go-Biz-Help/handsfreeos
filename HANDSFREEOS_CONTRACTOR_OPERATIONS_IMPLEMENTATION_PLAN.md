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
3. **Crews, scheduling and work orders.** _Built, on the web; the phone's pages come with part 6._ Crews
   (decision 7), booked from the job; a work order on each visit (instructions, checklist, materials to bring, who's
   going, photos required); starter checklists per trade; Done waits on the required items (decision 8); one dispatch
   screen.
4. **Materials.** _Built, on the web; the phone's pages come with part 6._ Per job (decision 9), with what's
   missing for each upcoming visit and an alert before it.
5. **Time and job costing.** Time from the status buttons (decision 10), each person's cost per hour, estimate
   against actual, the profit it's heading for, and a profit dashboard by job, crew, service and customer.
6. **The phone field app.** Jobs, work orders, checklists, photos, materials used, time and voice notes, all with no
   signal.
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
  (part 5). The phone's builder (part 6). An estimate the AI drafts on its own, which always waits for a person
  (part 7).
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
