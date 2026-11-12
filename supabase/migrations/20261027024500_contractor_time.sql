-- =============================================================================
-- Contractor Operations, part 5: time and job costing
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        Time comes from the buttons a crew already taps on a visit (the
--        owner's decision 10): On the way starts travel time, Started starts
--        work time, Waiting on parts or Done stops it, and a Break button
--        pauses one person. Each person's cost per hour turns those hours
--        into what the labor really cost, beside what the materials and
--        everything else cost, against the job's budget.
--
--        - **time_entries**: one stretch of one person's time on a job:
--          travel, work or a break, from when to when. Fixing one takes
--          someone who may (a new permission, `contractor.fix_time`), with
--          a reason.
--        - **time_costs**: what an hour of that stretch cost the business,
--          kept apart so only people who may see job costs read it
--          (decision 11), and kept as it was then, so a raise later never
--          changes what a finished job cost.
--        - **labor_rates**: what an hour of each person costs the business.
--        - **other_costs**: what else a job cost: a permit, a dump fee, a
--          subcontractor's bill.
--
-- Core never points here; these tables point at core's appointments and users.
-- =============================================================================

select private.register_addon_permissions('contractor', '[
  {"key": "contractor.fix_time", "label": "Fix time on jobs",
   "description": "Change, add and remove the time tracked on jobs, with a reason (the owner’s decision 10).",
   "defaultRoles": ["admin"], "requires": ["contractor.use"]}
]'::jsonb);

-- ---------- time on a job ----------
create table addon_contractor.time_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The job it's on.
  record_id uuid not null,
  -- The visit it was on. Kept on the job when the visit is deleted for good.
  appointment_id uuid references app.appointments (id) on delete set null,
  -- Whose time it is. Kept, without a name, when they leave HandsFreeOS.
  user_id uuid references app.users (id) on delete set null,
  kind text not null check (kind in ('travel', 'work', 'break')),
  started_at timestamptz not null,
  -- Null while it's running.
  ended_at timestamptz,
  -- How it came to be: the visit's status buttons, the Break button, or someone who may fix time.
  source text not null default 'status' check (source in ('status', 'break', 'added')),
  -- It was left running past the limit and stopped on its own: someone who may fix time should look.
  auto_stopped boolean not null default false,
  -- Who last fixed it, when and why.
  fixed_by uuid references app.users (id) on delete set null,
  fixed_at timestamptz,
  fix_reason text check (fix_reason is null or length(btrim(fix_reason)) between 1 and 300),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (ended_at is null or ended_at >= started_at),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index time_entries_job_idx on addon_contractor.time_entries (workspace_id, record_id, started_at);
create index time_entries_appointment_idx on addon_contractor.time_entries (appointment_id)
  where appointment_id is not null;
create index time_entries_user_idx on addon_contractor.time_entries (user_id, started_at)
  where user_id is not null;
-- Nobody is in two places: one running stretch per person in a business.
create unique index time_entries_running_idx on addon_contractor.time_entries (workspace_id, user_id)
  where ended_at is null and user_id is not null;
create index time_entries_fixed_by_idx on addon_contractor.time_entries (fixed_by) where fixed_by is not null;
create index time_entries_created_by_idx on addon_contractor.time_entries (created_by)
  where created_by is not null;
-- Everyone who uses the add-on sees the hours and takes their own break; who may fix one is the command's rule.
select private.addon_table_policies('addon_contractor.time_entries', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- ---------- what an hour of it cost ----------
create table addon_contractor.time_costs (
  entry_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_id uuid not null,
  -- What an hour of this person cost the business when the time was tracked.
  rate_cents bigint not null check (rate_cents between 0 and 100000000),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, entry_id) references addon_contractor.time_entries (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index time_costs_job_idx on addon_contractor.time_costs (workspace_id, record_id);
create index time_costs_entry_idx on addon_contractor.time_costs (workspace_id, entry_id);
-- Read only by people who may see job costs and profit (the owner's decision 11).
select private.addon_table_policies('addon_contractor.time_costs', 'contractor.costs', 'contractor.costs', 'contractor.costs', 'record_id');

-- ---------- what an hour of each person costs ----------
create table addon_contractor.labor_rates (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- What an hour of them costs the business: pay, taxes and whatever else it counts.
  cost_cents bigint not null check (cost_cents between 0 and 100000000),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index labor_rates_user_idx on addon_contractor.labor_rates (user_id);
create index labor_rates_updated_by_idx on addon_contractor.labor_rates (updated_by)
  where updated_by is not null;
-- Read by anyone who sees costs; set only by the people who set how the business estimates.
select private.addon_table_policies('addon_contractor.labor_rates', 'contractor.costs', 'contractor.approve');

-- ---------- what else a job cost ----------
create table addon_contractor.other_costs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  amount_cents bigint not null check (amount_cents between 0 and 100000000000),
  -- The day it was spent.
  spent_on date not null,
  note text check (note is null or length(note) <= 500),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index other_costs_job_idx on addon_contractor.other_costs (workspace_id, record_id, spent_on);
create index other_costs_created_by_idx on addon_contractor.other_costs (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_contractor.other_costs', 'contractor.costs', 'contractor.costs', 'contractor.costs', 'record_id');

-- Owners and admins in businesses where the add-on already runs get the new permission now.
select private.refresh_workspace_access(wa.user_id, wa.workspace_id)
from app.workspace_access wa
join app.addon_installations i on i.workspace_id = wa.workspace_id
where i.addon_id = 'contractor' and i.state = 'enabled';
