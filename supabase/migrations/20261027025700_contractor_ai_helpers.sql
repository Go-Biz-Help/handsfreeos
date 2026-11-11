-- =============================================================================
-- Contractor Operations, part 7: the AI helpers
-- (HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md, docs/contractor.md).
--
--        The owner's rule: "For anything involving safety, code compliance,
--        contracts, or significant spending, the AI should prepare and
--        recommend actions while authorized humans retain approval." So each
--        helper prepares something and leaves the deciding to a person.
--
--        - **estimate_drafts**: an estimate the AI drafted for a job from its
--          notes, photos and what someone typed. It is only ever a draft
--          beside the job: it becomes an estimate when a person opens it in
--          the builder, checks it and saves it (the owner's decision 6: "An
--          estimate the AI drafts always waits for a person"). It holds what
--          lines cost, so only people who may see job costs read it.
--        - **budget_watch**: where each job's budget stood when it was last
--          looked at (within plan, over, under the lowest margin, a loss),
--          and what the AI said is driving it. People who may see job costs
--          are told when it gets worse; nobody else reads it (decision 11).
--        - **daily_reports**: one report per job per day, written from what
--          the crew left that day (notes, photos, ticks, hours). No money in
--          it, so everyone on the job reads it. Its update for the customer
--          goes only when a person sends it.
--
-- Only adds. Core never points here; these tables point at core's users,
-- files and estimates. Nothing new goes to phones.
-- =============================================================================

-- ---------- an estimate the AI drafted ----------
create table addon_contractor.estimate_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The job it's for.
  record_id uuid not null,
  -- Who asked for it.
  asked_by uuid references app.users (id) on delete set null,
  -- What they typed: the work wanted, and measurements.
  brief text check (brief is null or length(brief) <= 4000),
  -- Its title, its options with every line (name, quantity, unit, price, kind, cost, and whether the cost is
  -- the AI's guess), what the AI assumed and what it couldn't tell.
  draft jsonb not null check (jsonb_typeof(draft) = 'object'),
  notes_read integer not null default 0 check (notes_read >= 0),
  photos_read integer not null default 0 check (photos_read >= 0),
  -- Waiting for someone, made into an estimate, or set aside.
  state text not null default 'ready' check (state in ('ready', 'used', 'dismissed')),
  -- The estimate a person saved from it.
  estimate_id uuid references app.estimates (id) on delete set null,
  settled_by uuid references app.users (id) on delete set null,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index estimate_drafts_job_idx on addon_contractor.estimate_drafts (workspace_id, record_id, created_at);
create index estimate_drafts_estimate_idx on addon_contractor.estimate_drafts (estimate_id)
  where estimate_id is not null;
create index estimate_drafts_asked_by_idx on addon_contractor.estimate_drafts (asked_by)
  where asked_by is not null;
create index estimate_drafts_settled_by_idx on addon_contractor.estimate_drafts (settled_by)
  where settled_by is not null;
-- It holds costs: read and settled only by people who may see them (decision 11).
select private.addon_table_policies('addon_contractor.estimate_drafts', 'contractor.costs', 'contractor.costs', 'contractor.costs', 'record_id');

-- ---------- where a job's budget stands ----------
create table addon_contractor.budget_watch (
  record_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  level text not null default 'ok' check (level in ('ok', 'over', 'under_margin', 'loss')),
  -- How many 10-point steps over its planned cost it was heading.
  band integer not null default 0 check (band between 0 and 20),
  -- What the AI said is driving it, and what the business could do. Its words may name amounts.
  why text check (why is null or length(why) <= 400),
  suggestions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggestions) = 'array'),
  advised_at timestamptz,
  -- When people were last told.
  warned_at timestamptz,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index budget_watch_job_idx on addon_contractor.budget_watch (workspace_id, record_id);
select private.addon_table_policies('addon_contractor.budget_watch', 'contractor.costs', 'contractor.costs', 'contractor.costs', 'record_id');

-- ---------- a job's day, written up ----------
create table addon_contractor.daily_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_id uuid not null,
  -- The business's own day.
  day date not null,
  summary text not null check (length(btrim(summary)) between 1 and 900),
  done jsonb not null default '[]'::jsonb check (jsonb_typeof(done) = 'array'),
  issues jsonb not null default '[]'::jsonb check (jsonb_typeof(issues) = 'array'),
  materials jsonb not null default '[]'::jsonb check (jsonb_typeof(materials) = 'array'),
  next_steps jsonb not null default '[]'::jsonb check (jsonb_typeof(next_steps) = 'array'),
  -- The update for the customer. It goes nowhere until a person sends it.
  for_customer text check (for_customer is null or length(for_customer) <= 1200),
  -- Who was on the clock that day and for how many hours. Never what they cost.
  crew jsonb not null default '[]'::jsonb check (jsonb_typeof(crew) = 'array'),
  -- The day's photos (core files on the job).
  photo_file_ids uuid[] not null default '{}' check (cardinality(photo_file_ids) <= 60),
  notes_read integer not null default 0 check (notes_read >= 0),
  photos_read integer not null default 0 check (photos_read >= 0),
  -- Who pressed Write; null when it was written on its own that evening.
  asked_by uuid references app.users (id) on delete set null,
  written_at timestamptz not null default now(),
  -- A person changed its words: it's theirs now, and never written over.
  edited_by uuid references app.users (id) on delete set null,
  edited_at timestamptz,
  -- The customer's update, once a person sent it.
  sent_by uuid references app.users (id) on delete set null,
  sent_at timestamptz,
  sent_channel text check (sent_channel is null or sent_channel in ('email', 'sms')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, record_id, day),
  check ((sent_at is null) = (sent_channel is null)),
  foreign key (workspace_id, record_id) references addon_contractor.jobs (workspace_id, record_id)
    on delete cascade
);
create index daily_reports_asked_by_idx on addon_contractor.daily_reports (asked_by) where asked_by is not null;
create index daily_reports_edited_by_idx on addon_contractor.daily_reports (edited_by) where edited_by is not null;
create index daily_reports_sent_by_idx on addon_contractor.daily_reports (sent_by) where sent_by is not null;
-- No money in a report: everyone who uses the add-on reads it. Who may change or send one is the command's rule.
select private.addon_table_policies('addon_contractor.daily_reports', 'contractor.use', 'contractor.use', 'contractor.use', 'record_id');
