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

1. **Jobs and projects.** _Built (this PR)._ The add-on, one side-menu row (Jobs, with Settings popping out). A job
   is a record of the add-on's kind, at a property (another of its kinds) tied to its customer. A service call, or a
   project with phases, deadlines, % done and a planned budget. Jobs page (board by status and a list; All, My jobs,
   Late; search; done and cancelled on a tick), a page for each job, and Settings (trades, a new project's phases).
   Visits booked or started on a job move it along. The Assistant can do all of it.
2. **Costs and estimates.** A cost on each price list item; an estimate builder with labor (hours × rate), materials
   at cost, markup, profit and margin, making a normal HandsFreeOS estimate; good, better, best options in core's
   estimates (decision 5); the lowest margin and its OK (decision 6). An accepted estimate fills the job's budget and
   its materials list.
3. **Crews, scheduling and work orders.** Crews (decision 7), booked from the job; a work order on each visit
   (instructions, checklist, materials to bring, who's going, photos required); starter checklists per trade; Done
   waits on the required items (decision 8); one dispatch screen.
4. **Materials.** Per job (decision 9), with what's missing for each upcoming visit and an alert before it.
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
