-- =============================================================================
-- 0066 · Everything after the records land: proving it worked, catching up
--        while the business still runs on the old system, and the handful of
--        things nobody can migrate for you.
--
--        The honest split this milestone insists on: a migration that brought
--        every record across perfectly is finished, even though Stripe still
--        has to be reconnected and a phone number still has to be ported. Those
--        are setup items, not failures, and they live in their own tables so
--        the report can say "124,829 records migrated · 4 things left to do"
--        rather than calling a clean import partly failed.
--
--        Transition Mode is one way only: the old system stays the truth until
--        the business says Finish. Chris chose 30 days, extendable, with a
--        reminder at seven left — and when the window runs out the sync does
--        not quietly stop, it asks.
-- =============================================================================

-- What a check looked at. Each is a different question, and the report shows them apart.
create type app.migration_check_kind as enum (
  'counts',        -- what the source said it had against what arrived
  'identity',      -- one record here per source record, and no duplicates
  'references',    -- no message without its conversation, no line without its invoice
  'fields',        -- the required fields are there and the stated transformations happened
  'history',       -- a sample: dates, authors, owners, direction, order
  'media',         -- the file is there, the right length, and the record still points at it
  'financial',     -- lines, taxes, totals and payments agree, to the cent
  'structure',     -- pipelines, stages, calendars, fields and forms kept their shape
  'transition',    -- the catch-up is current and the drift is under the line
  'rollback'       -- what was removed and put back adds up
);
create type app.migration_check_result as enum ('passed', 'warned', 'failed', 'skipped');

-- A thing a person has to go and do. Not a failure of the import.
create type app.reconnect_kind as enum (
  'payments', 'calendar', 'mailbox', 'social', 'messaging', 'accounting', 'meetings',
  'reviews', 'dns', 'other'
);
create type app.reconnect_state as enum ('todo', 'in_progress', 'done', 'not_needed', 'blocked');

-- Moving a phone number is the carrier's process, not a copy. These are its steps.
create type app.port_state as enum (
  'not_started', 'information_required', 'documents_required', 'ready_to_submit', 'submitted',
  'carrier_review', 'scheduled', 'complete', 'rejected', 'cancelled', 'needs_attention'
);

-- ---------- proving it worked ----------
create table app.migration_verifications (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  category text check (category is null or length(btrim(category)) between 1 and 60),
  kind app.migration_check_kind not null,
  result app.migration_check_result not null default 'skipped',
  -- The two numbers a person compares, and how far apart they are allowed to be.
  expected_count bigint,
  actual_count bigint,
  discrepancy bigint not null default 0,
  tolerance bigint not null default 0 check (tolerance >= 0),
  summary text check (summary is null or length(summary) <= 1000),
  -- A handful of examples, sanitized: ids and field names, never a customer's words.
  samples jsonb not null default '[]'::jsonb
    check (jsonb_typeof(samples) = 'array' and pg_column_size(samples) <= 65536),
  ran_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index migration_verifications_key on app.migration_verifications
  (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), kind,
   coalesce(category, ''));
create index migration_verifications_list on app.migration_verifications (migration_id, result);

-- ---------- the things nobody can migrate for you ----------
create table app.migration_reconnect_tasks (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  workspace_id uuid references app.workspaces (id) on delete cascade,
  kind app.reconnect_kind not null,
  -- What it was over there ('Stripe', 'Google Calendar', 'mail.lonestarhvac.com'), and only what is needed to
  -- point somebody at the right place. Never a token, a key or a secret — those are not migrated at all.
  provider text not null check (length(btrim(provider)) between 1 and 80),
  label text not null check (length(btrim(label)) between 1 and 200),
  state app.reconnect_state not null default 'todo',
  instructions text check (instructions is null or length(instructions) <= 4000),
  -- Where in HandsFreeOS this is done, so the item is a link and not a treasure hunt.
  settings_path text check (settings_path is null or length(btrim(settings_path)) between 1 and 200),
  descriptor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(descriptor) = 'object' and pg_column_size(descriptor) <= 16384),
  -- Money and live sending wait for this; history never does.
  blocks_live_use boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'done') = (completed_at is not null))
);
create unique index migration_reconnect_tasks_key on app.migration_reconnect_tasks
  (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, provider, label);
create index migration_reconnect_tasks_open on app.migration_reconnect_tasks (migration_id, state);
create trigger migration_reconnect_tasks_updated_at before update on app.migration_reconnect_tasks
  for each row execute function private.set_updated_at();

-- ---------- moving a phone number ----------
-- Discovering the number is data. Moving it is a carrier process with paperwork, a date, and a real risk of
-- a business losing its calls. So: the customer chooses which ones, submitting is an explicit act, and
-- rolling back a migration never cancels a port that is already with the carrier.
create table app.migration_port_requests (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  workspace_id uuid references app.workspaces (id) on delete cascade,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  friendly_name text check (friendly_name is null or length(btrim(friendly_name)) between 1 and 200),
  -- What the old system said the number can do, and who it rang.
  capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 8192),
  state app.port_state not null default 'not_started',
  selected boolean not null default false,
  -- The carrier's own reference and what it last said, so support can answer "where is my port?".
  external_reference text check (external_reference is null or length(btrim(external_reference)) between 1 and 200),
  carrier_status text check (carrier_status is null or length(carrier_status) <= 300),
  -- Which of the papers are in. The documents themselves live in storage, never in this row.
  documents jsonb not null default '{}'::jsonb
    check (jsonb_typeof(documents) = 'object' and pg_column_size(documents) <= 16384),
  scheduled_for timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  -- The number here once it has moved, so calls arrive where the history already is.
  phone_number_id uuid references app.phone_numbers (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'complete') = (completed_at is not null))
);
create unique index migration_port_requests_key on app.migration_port_requests (migration_id, e164);
create index migration_port_requests_open on app.migration_port_requests (migration_id, state);
create trigger migration_port_requests_updated_at before update on app.migration_port_requests
  for each row execute function private.set_updated_at();

-- ---------- catching up until cutover ----------
-- One cursor per category per sub-account. Webhooks are a hint that something changed, never proof that
-- everything did — so every category also has a scheduled sweep, and `drift` is what the screen shows when
-- the two disagree.
create table app.migration_transition_cursors (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  category text not null check (length(btrim(category)) between 1 and 60),
  -- How this category keeps up: by the source telling us, by asking on a timer, or not at all (and then the
  -- screen says so instead of pretending).
  mode text not null default 'poll' check (mode in ('webhook', 'poll', 'both', 'none')),
  cursor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor) = 'object' and pg_column_size(cursor) <= 16384),
  -- The newest source change taken in, when we last asked, and when to ask again.
  synced_through_at timestamptz,
  last_run_at timestamptz,
  next_run_at timestamptz,
  interval_seconds integer not null default 900 check (interval_seconds between 60 and 86400),
  -- How far behind, in seconds, and how many records the last sweep found that the hints had missed.
  lag_seconds integer not null default 0 check (lag_seconds >= 0),
  drift bigint not null default 0,
  failures integer not null default 0 check (failures between 0 and 1000000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index migration_transition_cursors_key on app.migration_transition_cursors (scope_id, category);
create index migration_transition_cursors_due on app.migration_transition_cursors (next_run_at)
  where next_run_at is not null;
create trigger migration_transition_cursors_updated_at before update on app.migration_transition_cursors
  for each row execute function private.set_updated_at();

-- A change the old system told us about. Kept as its own row so the same notice arriving twice, or out of
-- order, or before the record it names, all come out the same way.
create table app.migration_transition_events (
  id bigserial primary key,
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  -- The source's own id for the notice, when it has one. That is what makes a repeat free.
  source_event_id text check (source_event_id is null or length(btrim(source_event_id)) between 1 and 300),
  source_object_type text not null check (length(btrim(source_object_type)) between 1 and 60),
  source_object_id text not null check (length(btrim(source_object_id)) between 1 and 300),
  category text not null check (length(btrim(category)) between 1 and 60),
  action text not null check (action in ('created', 'updated', 'deleted')),
  -- When it happened over there, and when we heard. The gap is the lag the screen shows.
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  state app.migration_item_state not null default 'discovered',
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  processed_at timestamptz
);
-- The same notice twice is one row.
create unique index migration_transition_events_key on app.migration_transition_events
  (scope_id, coalesce(source_event_id, source_object_type || ':' || source_object_id || ':' || action));
create index migration_transition_events_work on app.migration_transition_events (migration_id, state, received_at);

-- A record the old system deleted while we were catching up. Never acted on straight away: it waits for the
-- policy, and the business's own later work here wins.
create table app.migration_tombstones (
  id bigserial primary key,
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  source_object_type text not null check (length(btrim(source_object_type)) between 1 and 60),
  source_object_id text not null check (length(btrim(source_object_id)) between 1 and 300),
  target_type text check (target_type is null or length(btrim(target_type)) between 1 and 60),
  target_id uuid,
  source_deleted_at timestamptz,
  -- 'pending' until the policy runs; then what it did.
  applied text not null default 'pending'
    check (applied in ('pending', 'archived', 'kept', 'ignored')),
  reason text check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create unique index migration_tombstones_key on app.migration_tombstones
  (scope_id, source_object_type, source_object_id);
create index migration_tombstones_pending on app.migration_tombstones (migration_id)
  where applied = 'pending';

-- ---------- references ----------
create trigger migration_verifications_check_refs before insert on app.migration_verifications
  for each row execute function private.check_migration_child_refs();
create trigger migration_reconnect_tasks_check_refs before insert on app.migration_reconnect_tasks
  for each row execute function private.check_migration_engine_refs();
create trigger migration_port_requests_check_refs before insert on app.migration_port_requests
  for each row execute function private.check_migration_engine_refs();
create trigger migration_transition_cursors_check_refs before insert on app.migration_transition_cursors
  for each row execute function private.check_migration_child_refs();
create trigger migration_transition_events_check_refs before insert on app.migration_transition_events
  for each row execute function private.check_migration_child_refs();
create trigger migration_tombstones_check_refs before insert on app.migration_tombstones
  for each row execute function private.check_migration_engine_refs();

-- ---------- RLS ----------
alter table app.migration_verifications enable row level security;
alter table app.migration_reconnect_tasks enable row level security;
alter table app.migration_port_requests enable row level security;
alter table app.migration_transition_cursors enable row level security;
alter table app.migration_transition_events enable row level security;
alter table app.migration_tombstones enable row level security;

create policy migration_verifications_select on app.migration_verifications for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_verifications_service_all on app.migration_verifications for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

-- The setup list is the one part of a migration the business's own owners and admins see, because they are
-- the ones who reconnect Stripe and change the DNS.
create policy migration_reconnect_tasks_select on app.migration_reconnect_tasks for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'workspace.update')));
create policy migration_reconnect_tasks_update on app.migration_reconnect_tasks for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'workspace.update')))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'workspace.update')));
create policy migration_reconnect_tasks_service_all on app.migration_reconnect_tasks for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_port_requests_select on app.migration_port_requests for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'channels.manage')));
create policy migration_port_requests_service_all on app.migration_port_requests for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_transition_cursors_select on app.migration_transition_cursors for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_transition_cursors_service_all on app.migration_transition_cursors for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_transition_events_select on app.migration_transition_events for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_transition_events_service_all on app.migration_transition_events for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_tombstones_select on app.migration_tombstones for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_tombstones_service_all on app.migration_tombstones for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

-- ---------- grants ----------
-- The one thing a person writes here is ticking a setup item off.
grant select on app.migration_verifications, app.migration_reconnect_tasks, app.migration_port_requests,
  app.migration_transition_cursors, app.migration_transition_events, app.migration_tombstones to authenticated;
grant update (state, completed_at, completed_by) on app.migration_reconnect_tasks to authenticated;
grant select, insert, update, delete on app.migration_verifications, app.migration_reconnect_tasks,
  app.migration_port_requests, app.migration_transition_cursors, app.migration_transition_events,
  app.migration_tombstones to service_actor;
grant usage, select on sequence app.migration_transition_events_id_seq, app.migration_tombstones_id_seq
  to service_actor;
revoke all on app.migration_verifications, app.migration_reconnect_tasks, app.migration_port_requests,
  app.migration_transition_cursors, app.migration_transition_events, app.migration_tombstones from anon;

-- ---------- where the reports live ----------
-- The completion report and the item-level error file. Paths are `<organization>/<migration>/…`, written by
-- the worker, read by the people who may manage migrations, and never public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('migrations', 'migrations', false, 52428800, array['text/csv', 'application/json', 'text/plain'])
on conflict (id) do nothing;

-- Read rules for all four buckets in one place, as each milestone that adds one rewrites it.
create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.workspace_id in (select private.accessible_workspace_ids()))
    when 'telephony' then coalesce(private.path_workspace(p_name) in (select private.accessible_workspace_ids()), false)
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end
$$;
