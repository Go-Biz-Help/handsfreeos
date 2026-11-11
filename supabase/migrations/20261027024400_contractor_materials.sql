-- =============================================================================
-- Contractor Operations, part 4: materials per job
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        A job's materials list (the owner's decision 9): what the job
--        needs, and how much of each is ordered, delivered, used, wasted and
--        returned. Stock in warehouses and vans, and orders to suppliers,
--        come in Phase 2: this is one job's list and nothing more.
--
--        - **materials**: one row per material on a job. It may be one of
--          the business's price list items, and may be needed for one visit
--          or for any of them. An approved estimate's material lines land
--          here once each.
--        - **material_costs**: what one of it costs the business, kept apart
--          so only people who may see job costs read it (decision 11).
--
-- Core never points here; these tables point at core's products, estimates,
-- appointments and users.
-- =============================================================================

-- ---------- a job's materials ----------
create table addon_contractor.materials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The job it's for.
  record_id uuid not null,
  position integer not null check (position between 0 and 9999),
  name text not null check (length(btrim(name)) between 1 and 200),
  unit_label text not null default 'each' check (length(btrim(unit_label)) between 1 and 30),
  -- The price list item it is, if it's one.
  product_id uuid references app.products (id) on delete set null,
  -- The visit it's needed for. Null: any visit on the job.
  appointment_id uuid references app.appointments (id) on delete set null,
  -- How much the job needs, and how much of it is ordered, delivered, used, wasted and returned so far.
  needed numeric(12, 3) not null default 0 check (needed between 0 and 1000000),
  ordered numeric(12, 3) not null default 0 check (ordered between 0 and 1000000),
  delivered numeric(12, 3) not null default 0 check (delivered between 0 and 1000000),
  used numeric(12, 3) not null default 0 check (used between 0 and 1000000),
  wasted numeric(12, 3) not null default 0 check (wasted between 0 and 1000000),
  returned numeric(12, 3) not null default 0 check (returned between 0 and 1000000),
  -- Where it's coming from, in the business's own words. Suppliers come in Phase 2.
  supplier text check (supplier is null or length(btrim(supplier)) between 1 and 120),
  -- The day an order is expected.
  expected_on date,
  note text check (note is null or length(note) <= 500),
  -- The approved estimate's line it came from: each lands once.
  estimate_id uuid references app.estimates (id) on delete set null,
  estimate_line integer check (estimate_line is null or estimate_line between 0 and 199),
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index materials_job_idx on addon_contractor.materials (workspace_id, record_id, position);
create unique index materials_estimate_line_idx
  on addon_contractor.materials (record_id, estimate_id, estimate_line) where estimate_id is not null;
create index materials_product_idx on addon_contractor.materials (product_id) where product_id is not null;
create index materials_appointment_idx on addon_contractor.materials (appointment_id)
  where appointment_id is not null;
create index materials_estimate_idx on addon_contractor.materials (estimate_id) where estimate_id is not null;
create index materials_created_by_idx on addon_contractor.materials (created_by) where created_by is not null;
create index materials_updated_by_idx on addon_contractor.materials (updated_by) where updated_by is not null;
-- Everyone who uses the add-on keeps a job's list: the office orders, the crew says what it used.
select private.addon_table_policies('addon_contractor.materials', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- ---------- what each costs the business ----------
create table addon_contractor.material_costs (
  material_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_id uuid not null,
  -- What one unit costs the business.
  unit_cost_cents bigint not null check (unit_cost_cents between 0 and 100000000000),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, material_id) references addon_contractor.materials (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index material_costs_job_idx on addon_contractor.material_costs (workspace_id, record_id);
create index material_costs_material_idx on addon_contractor.material_costs (workspace_id, material_id);
create index material_costs_updated_by_idx on addon_contractor.material_costs (updated_by)
  where updated_by is not null;
-- Read and set only by people who may see job costs and profit (the owner's decision 11).
select private.addon_table_policies('addon_contractor.material_costs', 'contractor.costs', 'contractor.costs', 'contractor.costs', 'record_id');
