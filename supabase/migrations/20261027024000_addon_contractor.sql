-- =============================================================================
-- Contractor Operations (contractor), part 1: jobs and projects
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        Started by `pnpm addon:new contractor`. The permissions are its
--        manifest's, and exist only while it runs in a business; the parity
--        test checks the two lists match.
--
--        A **job** is a record of the add-on's kind `contractor_job`, so its
--        timeline, notes, files, tasks, visits (appointments on the record)
--        and search are core's. This table holds the rest: a service call or
--        a project (the owner's decision 2), its status and why, its trade,
--        the work to do, its start and deadline (days, in the business's time
--        zone), its % done (from its phases for a project) and its lead. Its
--        customer and its property (a record of the kind `contractor_property`)
--        are relationships, so both show on core's record pages.
--
--        A project's **phases** are in order, each with its status, % done
--        and dates. The job's **team** is the people working it besides its
--        lead (crews come in part 3).
--
--        A job's **money** (its price to the customer, its budget by labor,
--        materials and other costs, and its labor hours) is a table of its
--        own, read and written only by people with `contractor.costs` (the
--        owner's decision 11): techs see their work, not the money.
-- =============================================================================

select private.register_addon_permissions('contractor', '[
  {"key": "contractor.use", "label": "Use Contractor Operations",
   "description": "See every job and project, start them, and change their status, phases, dates, team and % done.",
   "defaultRoles": ["admin", "member"]},
  {"key": "contractor.costs", "label": "See job costs and profit",
   "description": "See and set what each job is priced at, its budget and the profit planned. Techs see their work without the money (the owner’s decision 11).",
   "defaultRoles": ["admin"], "requires": ["contractor.use"]},
  {"key": "contractor.manage", "label": "Set up Contractor Operations",
   "description": "Pick the business’s trades and the phases a new project starts with.",
   "defaultRoles": ["admin"], "requires": ["contractor.use"]}
]'::jsonb);

select private.create_addon_schema('contractor');

-- ---------- jobs ----------
create table addon_contractor.jobs (
  record_id uuid primary key references app.custom_records (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null default 'service' check (kind in ('service', 'project')),
  status text not null default 'new'
    check (status in ('new', 'scheduled', 'in_progress', 'on_hold', 'done', 'cancelled')),
  status_at timestamptz not null default now(),
  status_by uuid references app.users (id) on delete set null,
  -- Why it's on hold or cancelled.
  status_reason text check (status_reason is null or length(status_reason) <= 300),
  trade text check (trade is null or trade in ('electrical', 'plumbing', 'hvac', 'roofing', 'remodeling', 'general')),
  details text check (details is null or length(details) <= 4000),
  starts_on date,
  due_on date,
  done_at timestamptz,
  -- A project's is its phases' average, kept by the commands that change them; a service call's is set by hand.
  percent_done integer not null default 0 check (percent_done between 0 and 100),
  lead_user_id uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, record_id),
  check (due_on is null or starts_on is null or due_on >= starts_on),
  check ((status = 'done') = (done_at is not null))
);
create index jobs_status_idx on addon_contractor.jobs (workspace_id, status, due_on);
create index jobs_lead_idx on addon_contractor.jobs (lead_user_id) where lead_user_id is not null;
create index jobs_status_by_idx on addon_contractor.jobs (status_by) where status_by is not null;
create index jobs_created_by_idx on addon_contractor.jobs (created_by) where created_by is not null;
select private.addon_table_policies('addon_contractor.jobs', 'contractor.use', 'contractor.use', null, 'record_id');

-- ---------- phases ----------
create table addon_contractor.phases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_id uuid not null,
  position integer not null check (position between 0 and 999),
  name text not null check (length(btrim(name)) between 1 and 80),
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'done')),
  percent_done integer not null default 0 check (percent_done between 0 and 100),
  starts_on date,
  due_on date,
  done_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id) on delete cascade,
  check (due_on is null or starts_on is null or due_on >= starts_on),
  check ((status = 'done') = (done_at is not null))
);
create unique index phases_name_idx on addon_contractor.phases (record_id, lower(btrim(name)));
create index phases_job_idx on addon_contractor.phases (workspace_id, record_id, position);
create index phases_created_by_idx on addon_contractor.phases (created_by) where created_by is not null;
select private.addon_table_policies('addon_contractor.phases', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- ---------- team ----------
create table addon_contractor.team (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_id uuid not null,
  user_id uuid not null references app.users (id) on delete cascade,
  added_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (record_id, user_id),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id) on delete cascade
);
create index team_job_idx on addon_contractor.team (workspace_id, record_id);
create index team_user_idx on addon_contractor.team (user_id);
create index team_added_by_idx on addon_contractor.team (added_by) where added_by is not null;
select private.addon_table_policies('addon_contractor.team', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- ---------- money: only for people who may see job costs and profit ----------
create table addon_contractor.money (
  record_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  price_cents bigint check (price_cents between 0 and 10000000000),
  labor_cents bigint check (labor_cents between 0 and 10000000000),
  materials_cents bigint check (materials_cents between 0 and 10000000000),
  other_cents bigint check (other_cents between 0 and 10000000000),
  labor_hours numeric(9, 2) check (labor_hours between 0 and 100000),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id) on delete cascade
);
create index money_job_idx on addon_contractor.money (workspace_id, record_id);
create index money_updated_by_idx on addon_contractor.money (updated_by) where updated_by is not null;
select private.addon_table_policies('addon_contractor.money', 'contractor.costs', 'contractor.costs', null, 'record_id');
