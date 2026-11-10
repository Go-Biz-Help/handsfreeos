# Contractor Operations

An add-on (`contractor`) for contractors and home service companies: electricians, plumbers, HVAC, roofers,
remodelers and general contractors. One shared engine runs jobs and projects, and later estimates with costs, crews,
work orders, materials, job costing and a field app, with trade tools inside it after that.

The owner's decisions and the build order are in `HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md`; the
numbers below (decision 1, and so on) are its decisions. Built: part 1, jobs and projects. The add-on is in
`development`, offered to nobody; staff give it to a business from Admin → Businesses.

## Where things are

| What                                                      | Where                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| The manifest: permissions, kinds of records, events, menu | `packages/core/src/addons/contractor/manifest.ts`                      |
| The tables (and their Drizzle mirror)                     | `supabase/migrations/20261027024000_addon_contractor.sql`, `tables.ts` |
| Trades and their starter phases                           | `trades.ts` (pure; web, phone and server all use it)                   |
| Statuses, % done, lateness and planned profit             | `progress.ts` (pure)                                                   |
| The pages' words, and every refusal's                     | `words.ts`                                                             |
| Shapes and limits                                         | `schemas.ts`                                                           |
| Jobs and properties: open, change, status, team, budget   | `ops/jobs.ts`                                                          |
| Phases                                                    | `ops/phases.ts`                                                        |
| Reading: overview, jobs, one job, properties              | `ops/queries.ts`                                                       |
| What it shares (loading a job, keeping % done, timelines) | `ops/common.ts`                                                        |
| Where the Assistant finds each page                       | `ai-places.ts`                                                         |
| A visit moving its job along                              | `apps/worker/src/addons/contractor/`                                   |
| The web pages                                             | `apps/web/src/addons/contractor/`, routes under `a/contractor/`        |
| The Assistant's checklist for its screens                 | `packages/core/src/assistant/ledger/contractor.json`                   |

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
  back.
- **% done.** A project with phases is the average of its phases' % done, kept by the server on every change
  (`keepPercent`). A service call's is set by hand. A phase's status and % move together: Done is 100%, Not started
  is 0%, and Started stays under 100%.
- **Visits.** Book a visit books a normal HandsFreeOS appointment for the job's record (`custom_record_id`), with
  its customer filled in. When one is booked, a new job moves to Scheduled; when its crew presses Started, a new or
  scheduled job moves to In progress. Neither ever moves a job backwards, or one that's on hold, done or cancelled.
- **Budget and price** (decision 11). Each job's price to the customer, labor, materials, other costs and labor
  hours live in `addon_contractor.money`, which row security keeps to `contractor.costs` (owners and admins by
  default). The job page shows the budget, the planned profit and the margin (in red under 20%, decision 6). Amounts
  stay off events and the timeline.
- **The team.** A job has one lead (anyone can lead their own; someone else takes `records.assign`) and up to 20
  others on its team. **My jobs** is the jobs someone leads or is on.
- **Late.** A job or phase past its deadline and not finished is late, by the business's time zone.
- **Settings** (decision 1). The trades the business does, and the phases a new project starts with, saved by
  core's `addon.save_settings` against the manifest's settings shape.

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
  phase wait on a Confirm card; look-ups, phases, % done and the team run on their own.
- **Archiving and deleting go through core.** The add-on never deletes a job's record itself; deleting a phase is
  the only delete, and the Assistant asks first.
- **Every screen item is in the Assistant's checklist,** and every person-run operation declares `ai`.

## Not yet

- Parts 2 to 7: costs and estimates (with good, better, best and the lowest margin), crews and work orders, materials,
  time and job costing, the phone's pages, and the AI helpers. See the plan.
- Panels on a customer's or a property's page: Contacts lists jobs and properties as their own kinds already.
- Checklists before Done (decision 8) come with work orders in part 3.
