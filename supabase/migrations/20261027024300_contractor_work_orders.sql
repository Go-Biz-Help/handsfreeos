-- =============================================================================
-- Contractor Operations, part 3: crews, work orders and dispatch
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        A visit on a job is an ordinary HandsFreeOS appointment whose record
--        is the job. The add-on keeps beside it what core doesn't: who goes
--        as a crew, and the visit's work order.
--
--        - **crews** and **crew_members**: a crew is a named group of people
--          on the business's team and subcontractors (the owner's decision
--          7). A subcontractor is a contact: they don't sign in, they get a
--          text with the job's details, and the office marks their work.
--        - **work_orders**: one per visit on a job: its instructions, what
--          to bring, and the crew it was given to. Who's going is the
--          visit's own people (core's) and its subcontractors here.
--        - **work_order_items**: the visit's checklist. An item is a box to
--          tick or a photo to add, and may be required. A job can't be
--          marked Done while a required item is left on one of its visits
--          (the owner's decision 8).
--        - **work_order_subs**: the subcontractors on a visit: when they
--          were told, and when the office marked their work done.
--
--        An owner or admin can mark a job done with required items left, with
--        a reason (decision 8): a new permission, `contractor.skip_checks`,
--        and the reason is kept on each item it passed over.
--
-- Core never points here; these tables point at core's appointments, people,
-- users and files.
-- =============================================================================

select private.register_addon_permissions('contractor', '[
  {"key": "contractor.skip_checks", "label": "Mark a job done with required items left",
   "description": "Mark a job done while required checklist items or photos are still left on its work orders, with a reason (the owner’s decision 8).",
   "defaultRoles": ["admin"], "requires": ["contractor.use"]}
]'::jsonb);

-- ---------- crews ----------
create table addon_contractor.crews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  -- A crew that's no longer used: kept, so the visits it worked still say its name.
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index crews_name_idx on addon_contractor.crews (workspace_id, lower(btrim(name)))
  where archived_at is null;
create index crews_created_by_idx on addon_contractor.crews (created_by) where created_by is not null;
-- Everyone who uses the add-on sees the crews; the people who set it up change them.
select private.addon_table_policies('addon_contractor.crews', 'contractor.use', 'contractor.manage');

create table addon_contractor.crew_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  crew_id uuid not null,
  -- Someone on the business's team, or a subcontractor (a contact): one or the other.
  user_id uuid references app.users (id) on delete cascade,
  person_id uuid references app.people (id) on delete cascade,
  added_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, crew_id) references addon_contractor.crews (workspace_id, id) on delete cascade,
  check ((user_id is null) <> (person_id is null))
);
create unique index crew_members_user_idx on addon_contractor.crew_members (crew_id, user_id)
  where user_id is not null;
create unique index crew_members_person_idx on addon_contractor.crew_members (crew_id, person_id)
  where person_id is not null;
create index crew_members_crew_idx on addon_contractor.crew_members (workspace_id, crew_id);
create index crew_members_user_fk_idx on addon_contractor.crew_members (user_id) where user_id is not null;
create index crew_members_person_fk_idx on addon_contractor.crew_members (person_id) where person_id is not null;
create index crew_members_added_by_idx on addon_contractor.crew_members (added_by) where added_by is not null;
select private.addon_table_policies('addon_contractor.crew_members', 'contractor.use', 'contractor.manage', 'contractor.manage');

-- ---------- a visit's work order ----------
create table addon_contractor.work_orders (
  appointment_id uuid primary key references app.appointments (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The job the visit is on.
  record_id uuid not null,
  -- The crew it was given to, if any. Who's going is the visit's own people and its subcontractors.
  crew_id uuid,
  instructions text check (instructions is null or length(instructions) <= 4000),
  -- What to bring: tools, parts, a ladder. The job's materials list comes with part 4.
  bring text check (bring is null or length(bring) <= 2000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, appointment_id),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade,
  foreign key (workspace_id, crew_id) references addon_contractor.crews (workspace_id, id)
    on delete set null (crew_id)
);
create index work_orders_job_idx on addon_contractor.work_orders (workspace_id, record_id);
create index work_orders_crew_idx on addon_contractor.work_orders (workspace_id, crew_id) where crew_id is not null;
create index work_orders_created_by_idx on addon_contractor.work_orders (created_by) where created_by is not null;
select private.addon_table_policies('addon_contractor.work_orders', 'contractor.use', 'contractor.use', null, 'record_id');

-- ---------- its checklist ----------
create table addon_contractor.work_order_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null,
  record_id uuid not null,
  position integer not null check (position between 0 and 999),
  label text not null check (length(btrim(label)) between 1 and 200),
  -- A box to tick, or a photo to add.
  kind text not null default 'check' check (kind in ('check', 'photo')),
  -- The job can't be marked Done while a required item is left (decision 8).
  required boolean not null default false,
  done_at timestamptz,
  done_by uuid references app.users (id) on delete set null,
  -- A photo item's photo, one of the job's files. The file deleted later leaves the item done.
  file_id uuid references app.files (id) on delete set null,
  -- An owner or admin marked the job done without it, and why.
  skipped_at timestamptz,
  skipped_by uuid references app.users (id) on delete set null,
  skip_reason text check (skip_reason is null or length(btrim(skip_reason)) between 1 and 300),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, appointment_id) references addon_contractor.work_orders (workspace_id, appointment_id)
    on delete cascade,
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade,
  check (done_by is null or done_at is not null),
  check ((skipped_at is null) = (skip_reason is null)),
  check (skipped_by is null or skipped_at is not null)
);
create index work_order_items_order_idx on addon_contractor.work_order_items (workspace_id, appointment_id, position);
-- The check before Done reads a job's required items that are left.
create index work_order_items_job_idx on addon_contractor.work_order_items (workspace_id, record_id);
create index work_order_items_done_by_idx on addon_contractor.work_order_items (done_by) where done_by is not null;
create index work_order_items_file_idx on addon_contractor.work_order_items (file_id) where file_id is not null;
create index work_order_items_skipped_by_idx on addon_contractor.work_order_items (skipped_by)
  where skipped_by is not null;
create index work_order_items_created_by_idx on addon_contractor.work_order_items (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_contractor.work_order_items', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- ---------- its subcontractors ----------
create table addon_contractor.work_order_subs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null,
  record_id uuid not null,
  person_id uuid not null references app.people (id) on delete cascade,
  -- When they were last texted the job's details, and by whom.
  told_at timestamptz,
  told_by uuid references app.users (id) on delete set null,
  -- The office marks their work: they don't sign in.
  done_at timestamptz,
  done_by uuid references app.users (id) on delete set null,
  note text check (note is null or length(note) <= 500),
  added_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, person_id),
  foreign key (workspace_id, appointment_id) references addon_contractor.work_orders (workspace_id, appointment_id)
    on delete cascade,
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade,
  check (told_by is null or told_at is not null),
  check (done_by is null or done_at is not null)
);
create index work_order_subs_order_idx on addon_contractor.work_order_subs (workspace_id, appointment_id);
create index work_order_subs_job_idx on addon_contractor.work_order_subs (workspace_id, record_id);
create index work_order_subs_person_idx on addon_contractor.work_order_subs (person_id);
create index work_order_subs_told_by_idx on addon_contractor.work_order_subs (told_by) where told_by is not null;
create index work_order_subs_done_by_idx on addon_contractor.work_order_subs (done_by) where done_by is not null;
create index work_order_subs_added_by_idx on addon_contractor.work_order_subs (added_by) where added_by is not null;
select private.addon_table_policies('addon_contractor.work_order_subs', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');

-- Owners and admins in businesses where the add-on already runs get the new permission now.
select private.refresh_workspace_access(wa.user_id, wa.workspace_id)
from app.workspace_access wa
join app.addon_installations i on i.workspace_id = wa.workspace_id
where i.addon_id = 'contractor' and i.state = 'enabled';
