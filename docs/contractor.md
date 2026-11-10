# Contractor Operations

An add-on (`contractor`) for contractors and home service companies: electricians, plumbers, HVAC, roofers,
remodelers and general contractors. One shared engine runs jobs and projects and estimates with costs, and later
crews, work orders, materials, job costing and a field app, with trade tools inside it after that.

The owner's decisions and the build order are in `HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md`; the
numbers below (decision 1, and so on) are its decisions. Built: part 1, jobs and projects, and part 2, costs and
estimates. The add-on is in
`development`, offered to nobody; staff give it to a business from Admin → Businesses.

## Where things are

| What                                                      | Where                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| The manifest: permissions, kinds of records, events, menu | `packages/core/src/addons/contractor/manifest.ts`                      |
| The tables (and their Drizzle mirror)                     | `supabase/migrations/20261027024000_addon_contractor.sql`, `tables.ts` |
| Part 2's tables: costs, estimates, OKs                    | `supabase/migrations/20261027024200_contractor_estimates.sql`          |
| Trades and their starter phases                           | `trades.ts` (pure; web, phone and server all use it)                   |
| Statuses, % done, lateness and planned profit             | `progress.ts` (pure)                                                   |
| The pages' words, and every refusal's                     | `words.ts`                                                             |
| Shapes and limits                                         | `schemas.ts`                                                           |
| Jobs and properties: open, change, status, team, budget   | `ops/jobs.ts`                                                          |
| Phases                                                    | `ops/phases.ts`                                                        |
| Cost, markup, margin and the lowest-margin check          | `estimating.ts` (pure; the builder and the server both use it)         |
| Item costs, how the business estimates, and the builder   | `ops/estimates.ts`                                                     |
| Reading: overview, jobs, one job, properties              | `ops/queries.ts`                                                       |
| What it shares (loading a job, keeping % done, timelines) | `ops/common.ts`                                                        |
| Where the Assistant finds each page                       | `ai-places.ts`                                                         |
| The worker: visits, approved estimates, OK alerts         | `apps/worker/src/addons/contractor/`                                   |
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
- **Archiving and deleting go through core.** The add-on never deletes a job's record itself; deleting a phase is
  the only delete, and the Assistant asks first.
- **Every screen item is in the Assistant's checklist,** and every person-run operation declares `ai`.

## Not yet

- Parts 3 to 7: crews and work orders, materials, time and job costing, the phone's pages, and the AI helpers. See
  the plan.
- An approved estimate fills its job's budget; filling the job's materials list comes with materials in part 4.
- An estimate the AI drafts on its own always waits for a person (decision 6): that comes with the AI helpers in
  part 7. Today the Assistant writes an estimate only as the person asking, on a Confirm card.
- The builder is on the web. On the phone, Money won't send such a draft and says to open it in Contractor
  Operations; the add-on's phone pages are part 6.
- Panels on a customer's or a property's page: Contacts lists jobs and properties as their own kinds already.
- Checklists before Done (decision 8) come with work orders in part 3.
