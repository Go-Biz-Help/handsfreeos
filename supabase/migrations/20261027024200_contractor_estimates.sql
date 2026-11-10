-- =============================================================================
-- Contractor Operations, part 2: costs and estimates
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        The add-on's estimate builder writes a normal HandsFreeOS estimate
--        (the owner's decision 4) through core's own commands, and keeps
--        beside it what core doesn't: what each line costs, the job it is
--        for, and the OK an estimate under the lowest margin waits for (the
--        owner's decision 6).
--
--        - **estimating**: the business's lowest margin (20% to start), the
--          markup a new line starts with, and what an hour of labor sells
--          for and costs. Set by the people who give the OK.
--        - **item_costs**: what one of each price list item costs the
--          business (labor by the hour, a material each). Only people who
--          may see job costs and profit read or write it (decision 11).
--        - **estimates**: one row per estimate the builder wrote: the job it
--          is for, and who asked for an OK and when. It holds no amounts, so
--          everyone who uses the add-on may read it.
--        - **estimate_costs**: each line's kind (labor, material, other) and
--          unit cost, by option and line position, rewritten whole on every
--          save. Costs only: `contractor.costs`.
--        - **estimate_oks**: an owner's or admin's OK to send an estimate as
--          it stood (`revision` is core's, so any later save needs a fresh
--          OK). Written only by people who may give one: a new permission,
--          `contractor.approve`.
--
-- Core never points here; these tables point at core's estimates and products.
-- =============================================================================

select private.register_addon_permissions('contractor', '[
  {"key": "contractor.approve", "label": "OK estimates under the lowest margin",
   "description": "OK an estimate that’s under the business’s lowest margin so it can be sent, and set that margin, the starting markup and labor’s hourly price and cost (the owner’s decision 6).",
   "defaultRoles": ["admin"], "requires": ["contractor.costs"]}
]'::jsonb);

-- ---------- how the business estimates ----------
create table addon_contractor.estimating (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  -- The lowest margin an estimate may go out at without an OK, in basis points: 2,000 is 20% (decision 6).
  min_margin_bp integer not null default 2000 check (min_margin_bp between 0 and 9000),
  -- What a new line's price starts at over its cost: 5,000 is 50%.
  markup_bp integer not null default 5000 check (markup_bp between 0 and 100000),
  -- An hour of labor: what the customer pays, and what it costs the business.
  labor_rate_cents bigint not null default 0 check (labor_rate_cents between 0 and 100000000),
  labor_cost_cents bigint not null default 0 check (labor_cost_cents between 0 and 100000000),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index estimating_updated_by_idx on addon_contractor.estimating (updated_by) where updated_by is not null;
-- Read by anyone who sees costs; set only by the people who give the OK it gates.
select private.addon_table_policies('addon_contractor.estimating', 'contractor.costs', 'contractor.approve');

-- ---------- what a price list item costs ----------
create table addon_contractor.item_costs (
  product_id uuid primary key references app.products (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null default 'material' check (kind in ('labor', 'material', 'other')),
  -- What one unit costs the business, in cents: an hour of labor, one of a material.
  cost_cents bigint not null check (cost_cents between 0 and 100000000000),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index item_costs_workspace_idx on addon_contractor.item_costs (workspace_id);
create index item_costs_updated_by_idx on addon_contractor.item_costs (updated_by) where updated_by is not null;
select private.addon_table_policies('addon_contractor.item_costs', 'contractor.costs', 'contractor.costs', 'contractor.costs');

-- ---------- the estimates its builder wrote ----------
create table addon_contractor.estimates (
  estimate_id uuid primary key references app.estimates (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The job it's for, if any. A job's data deleted leaves the estimate, which is core's.
  record_id uuid,
  asked_at timestamptz,
  asked_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, estimate_id),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete set null (record_id),
  check (asked_by is null or asked_at is not null)
);
create index estimates_job_idx on addon_contractor.estimates (workspace_id, record_id) where record_id is not null;
create index estimates_asked_idx on addon_contractor.estimates (workspace_id, asked_at) where asked_at is not null;
create index estimates_asked_by_idx on addon_contractor.estimates (asked_by) where asked_by is not null;
create index estimates_created_by_idx on addon_contractor.estimates (created_by) where created_by is not null;
select private.addon_table_policies('addon_contractor.estimates', 'contractor.use', 'contractor.costs', 'contractor.costs', 'record_id');

-- ---------- what each line costs ----------
create table addon_contractor.estimate_costs (
  estimate_id uuid not null,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- 1 for an estimate with one price; otherwise the option, counted from 1 as core counts them.
  option_position integer not null check (option_position between 1 and 3),
  -- The line's place in its option, counted from 0 as core's lines are.
  line_position integer not null check (line_position between 0 and 199),
  kind text not null check (kind in ('labor', 'material', 'other')),
  unit_cost_cents bigint check (unit_cost_cents between 0 and 100000000000),
  primary key (estimate_id, option_position, line_position),
  foreign key (workspace_id, estimate_id) references addon_contractor.estimates (workspace_id, estimate_id)
    on delete cascade
);
create index estimate_costs_workspace_idx on addon_contractor.estimate_costs (workspace_id, estimate_id);
select private.addon_table_policies('addon_contractor.estimate_costs', 'contractor.costs', 'contractor.costs', 'contractor.costs');

-- ---------- the OK to send one under the lowest margin ----------
create table addon_contractor.estimate_oks (
  estimate_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The estimate as it stood when it was OK'd (core's revision). Any later save needs a fresh OK.
  revision bigint not null,
  ok_by uuid references app.users (id) on delete set null,
  ok_at timestamptz not null default now(),
  note text check (note is null or length(note) <= 500),
  foreign key (workspace_id, estimate_id) references addon_contractor.estimates (workspace_id, estimate_id)
    on delete cascade
);
create index estimate_oks_workspace_idx on addon_contractor.estimate_oks (workspace_id, estimate_id);
create index estimate_oks_ok_by_idx on addon_contractor.estimate_oks (ok_by) where ok_by is not null;
select private.addon_table_policies('addon_contractor.estimate_oks', 'contractor.use', 'contractor.approve', 'contractor.approve');
