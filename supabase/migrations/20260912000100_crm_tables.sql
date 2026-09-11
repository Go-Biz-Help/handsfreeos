-- =============================================================================
-- 0006 · CRM core tables: pipelines and stages, companies, people, tags, leads,
--        tasks, activities, files, imports. Plus the triggers that keep the
--        invariants no matter which role writes (updated_at, immutable tenant
--        columns, lead status from the stage kind, stage guards, archive guard,
--        immutable system activities, default pipeline per workspace).
--        Grants live here; RLS policies and permissions arrive in 0007.
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

create type app.stage_kind as enum ('open', 'won', 'lost');
create type app.lead_status as enum ('open', 'won', 'lost');
create type app.record_type as enum ('person', 'company', 'lead');
create type app.activity_kind as enum ('note', 'call', 'visit', 'email', 'sms', 'system');
create type app.file_status as enum ('pending', 'ready');
create type app.import_kind as enum ('people', 'companies');
create type app.import_status as enum ('pending', 'running', 'done', 'failed', 'cancelled');

-- ---------- imports (referenced by people and companies) ----------
create table app.imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind app.import_kind not null,
  file_name text not null check (length(file_name) between 1 and 200),
  object_path text not null unique,
  mapping jsonb not null default '{}'::jsonb,
  options jsonb not null default '{}'::jsonb,
  status app.import_status not null default 'pending',
  total_rows int not null default 0,
  processed_rows int not null default 0,
  created_count int not null default 0,
  updated_count int not null default 0,
  skipped_count int not null default 0,
  error_count int not null default 0,
  last_error text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index imports_workspace_idx on app.imports (workspace_id, created_at desc);
create trigger imports_updated_at before update on app.imports for each row execute function private.set_updated_at();
create trigger imports_immutable before update on app.imports for each row execute function private.forbid_tenant_column_change('workspace_id', 'kind', 'object_path', 'created_by');

create table app.import_errors (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references app.imports (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  row_number int not null,
  message text not null,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index import_errors_import_idx on app.import_errors (import_id, row_number);

-- ---------- pipelines and stages ----------
create table app.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  position int not null default 0,
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pipelines_name_unique on app.pipelines (workspace_id, lower(name)) where archived_at is null;
create index pipelines_workspace_idx on app.pipelines (workspace_id, position);
create trigger pipelines_updated_at before update on app.pipelines for each row execute function private.set_updated_at();
create trigger pipelines_immutable before update on app.pipelines for each row execute function private.forbid_tenant_column_change('workspace_id');

create table app.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  pipeline_id uuid not null references app.pipelines (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  kind app.stage_kind not null default 'open',
  position int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pipeline_id, position) deferrable initially deferred
);
create unique index pipeline_stages_name_unique on app.pipeline_stages (pipeline_id, lower(name));
create index pipeline_stages_pipeline_idx on app.pipeline_stages (pipeline_id, position);
create trigger pipeline_stages_updated_at before update on app.pipeline_stages for each row execute function private.set_updated_at();
create trigger pipeline_stages_immutable before update on app.pipeline_stages for each row execute function private.forbid_tenant_column_change('workspace_id', 'pipeline_id');

-- A stage belongs to a pipeline of the same workspace.
create or replace function private.check_stage_pipeline()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.pipelines p where p.id = new.pipeline_id and p.workspace_id = new.workspace_id) then
    raise exception 'Stage must belong to a pipeline of the same workspace' using errcode = '23514', detail = 'stage_pipeline_mismatch';
  end if;
  return new;
end $$;
create trigger pipeline_stages_check_pipeline before insert on app.pipeline_stages
  for each row execute function private.check_stage_pipeline();

-- Every pipeline keeps at least one open, one won and one lost stage (checked after deletes and kind changes).
create or replace function private.check_pipeline_stage_kinds()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_pipeline uuid := coalesce(new.pipeline_id, old.pipeline_id);
  v_total int;
begin
  select count(*) into v_total from app.pipeline_stages s where s.pipeline_id = v_pipeline;
  if v_total = 0 then return null; end if; -- the pipeline itself is going away
  if not exists (select 1 from app.pipeline_stages s where s.pipeline_id = v_pipeline and s.kind = 'open')
     or not exists (select 1 from app.pipeline_stages s where s.pipeline_id = v_pipeline and s.kind = 'won')
     or not exists (select 1 from app.pipeline_stages s where s.pipeline_id = v_pipeline and s.kind = 'lost') then
    raise exception 'A pipeline needs at least one open, one won and one lost stage' using errcode = '23514', detail = 'last_stage_of_kind';
  end if;
  return null;
end $$;
create trigger pipeline_stages_keep_kinds after delete or update of kind on app.pipeline_stages
  for each row execute function private.check_pipeline_stage_kinds();

-- A stage with leads (archived ones included) cannot change what it means.
create or replace function private.forbid_stage_kind_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.kind <> new.kind and exists (select 1 from app.leads l where l.stage_id = old.id) then
    raise exception 'Move the leads out of this stage before changing its kind' using errcode = '23514', detail = 'stage_has_leads';
  end if;
  return new;
end $$;
create trigger pipeline_stages_kind_guard before update of kind on app.pipeline_stages
  for each row execute function private.forbid_stage_kind_change();

-- ---------- companies ----------
create table app.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  email extensions.citext,
  phone text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  website text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  notes text,
  source text,
  owner_user_id uuid references app.users (id) on delete set null,
  import_id uuid references app.imports (id) on delete set null,
  import_row int,
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text generated always as (
    lower(coalesce(name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, ''))
  ) stored
);
create index companies_workspace_idx on app.companies (workspace_id, archived_at, lower(name));
create index companies_email_idx on app.companies (workspace_id, email) where email is not null;
create index companies_phone_idx on app.companies (workspace_id, phone_e164) where phone_e164 is not null;
create index companies_search_idx on app.companies using gin (search_text extensions.gin_trgm_ops);
create unique index companies_import_row_unique on app.companies (import_id, import_row) where import_id is not null;
create trigger companies_updated_at before update on app.companies for each row execute function private.set_updated_at();
create trigger companies_immutable before update on app.companies for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- people ----------
create table app.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  company_id uuid references app.companies (id) on delete set null,
  first_name text not null default '',
  last_name text not null default '',
  email extensions.citext,
  phone text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_alt text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  notes text,
  source text,
  owner_user_id uuid references app.users (id) on delete set null,
  import_id uuid references app.imports (id) on delete set null,
  import_row int,
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text generated always as (
    lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(phone_e164, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address_line1, ''))
  ) stored,
  check (length(btrim(first_name)) + length(btrim(last_name)) > 0),
  check (length(first_name) <= 80 and length(last_name) <= 80)
);
create index people_workspace_idx on app.people (workspace_id, archived_at, lower(last_name), lower(first_name));
create index people_company_idx on app.people (company_id) where company_id is not null;
create index people_email_idx on app.people (workspace_id, email) where email is not null;
create index people_phone_idx on app.people (workspace_id, phone_e164) where phone_e164 is not null;
create index people_search_idx on app.people using gin (search_text extensions.gin_trgm_ops);
create unique index people_import_row_unique on app.people (import_id, import_row) where import_id is not null;
create trigger people_updated_at before update on app.people for each row execute function private.set_updated_at();
create trigger people_immutable before update on app.people for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- A person's company must be in the same workspace.
create or replace function private.check_person_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.company_id is not null and not exists (select 1 from app.companies c where c.id = new.company_id and c.workspace_id = new.workspace_id) then
    raise exception 'Company must belong to the same workspace' using errcode = '23514', detail = 'company_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger people_check_company before insert or update of company_id on app.people
  for each row execute function private.check_person_company();

-- ---------- tags ----------
create table app.tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name extensions.citext not null check (length(btrim(name::text)) between 1 and 40),
  color text not null default '#2d69d8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create trigger tags_updated_at before update on app.tags for each row execute function private.set_updated_at();
create trigger tags_immutable before update on app.tags for each row execute function private.forbid_tenant_column_change('workspace_id');

create table app.record_tags (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  tag_id uuid not null references app.tags (id) on delete cascade,
  record_type app.record_type not null,
  record_id uuid not null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tag_id, record_type, record_id)
);
create index record_tags_record_idx on app.record_tags (workspace_id, record_type, record_id);

-- ---------- leads ----------
create table app.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  pipeline_id uuid not null references app.pipelines (id) on delete restrict,
  stage_id uuid not null references app.pipeline_stages (id) on delete restrict,
  person_id uuid references app.people (id) on delete restrict,
  company_id uuid references app.companies (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 160),
  value_cents bigint not null default 0 check (value_cents >= 0),
  source text,
  assignee_user_id uuid references app.users (id) on delete set null,
  expected_close_on date,
  next_action text check (next_action is null or length(next_action) <= 200),
  next_action_at timestamptz,
  status app.lead_status not null default 'open',
  won_at timestamptz,
  lost_at timestamptz,
  lost_reason text check (lost_reason is null or length(lost_reason) <= 300),
  position bigint not null default 0,
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text generated always as (lower(coalesce(title, ''))) stored,
  check (person_id is not null or company_id is not null)
);
create index leads_board_idx on app.leads (workspace_id, pipeline_id, stage_id, position);
create index leads_status_idx on app.leads (workspace_id, status, next_action_at);
create index leads_assignee_idx on app.leads (workspace_id, assignee_user_id);
create index leads_person_idx on app.leads (person_id) where person_id is not null;
create index leads_company_idx on app.leads (company_id) where company_id is not null;
create index leads_search_idx on app.leads using gin (search_text extensions.gin_trgm_ops);
create trigger leads_updated_at before update on app.leads for each row execute function private.set_updated_at();
create trigger leads_immutable before update on app.leads for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- Status follows the stage kind; the stage must belong to the lead's pipeline; a lost stage needs a reason.
create or replace function private.sync_lead_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind app.stage_kind;
  v_stage_pipeline uuid;
  v_stage_workspace uuid;
begin
  select s.kind, s.pipeline_id, s.workspace_id into v_kind, v_stage_pipeline, v_stage_workspace
  from app.pipeline_stages s where s.id = new.stage_id;
  if v_kind is null then
    raise exception 'Stage not found' using errcode = '23503', detail = 'stage_not_found';
  end if;
  if v_stage_pipeline <> new.pipeline_id or v_stage_workspace <> new.workspace_id then
    raise exception 'Stage belongs to a different pipeline' using errcode = '23514', detail = 'stage_pipeline_mismatch';
  end if;
  if (new.person_id is not null and not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.company_id is not null and not exists (select 1 from app.companies c where c.id = new.company_id and c.workspace_id = new.workspace_id)) then
    raise exception 'Lead must belong to a person or company of the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  if v_kind = 'lost' and coalesce(btrim(new.lost_reason), '') = '' then
    raise exception 'A reason is required to mark a lead lost' using errcode = '23514', detail = 'lost_reason_required';
  end if;
  new.status := v_kind::text::app.lead_status;
  if v_kind = 'won' then
    new.won_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'won' then old.won_at end, now());
    new.lost_at := null;
  elsif v_kind = 'lost' then
    new.lost_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'lost' then old.lost_at end, now());
    new.won_at := null;
  else
    new.won_at := null;
    new.lost_at := null;
    new.lost_reason := null;
  end if;
  return new;
end $$;
create trigger leads_sync_status before insert or update on app.leads
  for each row execute function private.sync_lead_status();

-- ---------- tasks ----------
create table app.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  notes text,
  due_at timestamptz,
  all_day boolean not null default true,
  assignee_user_id uuid references app.users (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  company_id uuid references app.companies (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  done_at timestamptz,
  done_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_workspace_due_idx on app.tasks (workspace_id, done_at, due_at);
create index tasks_assignee_idx on app.tasks (assignee_user_id, done_at) where assignee_user_id is not null;
create index tasks_person_idx on app.tasks (person_id) where person_id is not null;
create index tasks_company_idx on app.tasks (company_id) where company_id is not null;
create index tasks_lead_idx on app.tasks (lead_id) where lead_id is not null;
create trigger tasks_updated_at before update on app.tasks for each row execute function private.set_updated_at();
create trigger tasks_immutable before update on app.tasks for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- activities (the customer timeline) ----------
create table app.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind app.activity_kind not null,
  subtype text,
  person_id uuid references app.people (id) on delete set null,
  company_id uuid references app.companies (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  body text check (body is null or length(body) <= 10000),
  occurred_at timestamptz not null default now(),
  author_user_id uuid references app.users (id) on delete set null,
  actor_type app.actor_type not null default 'human',
  event_id uuid unique references app.events (id) on delete restrict,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (person_id is not null or company_id is not null or lead_id is not null)
);
create index activities_person_idx on app.activities (workspace_id, person_id, occurred_at desc, id desc) where person_id is not null;
create index activities_company_idx on app.activities (workspace_id, company_id, occurred_at desc, id desc) where company_id is not null;
create index activities_lead_idx on app.activities (workspace_id, lead_id, occurred_at desc, id desc) where lead_id is not null;
create trigger activities_updated_at before update on app.activities for each row execute function private.set_updated_at();
create trigger activities_immutable before update on app.activities for each row execute function private.forbid_tenant_column_change('workspace_id', 'kind', 'author_user_id', 'actor_type', 'event_id');

-- System entries are derived from events: nobody edits or deletes them.
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.kind = 'system' then
    raise exception 'System timeline entries cannot be changed' using errcode = '42501', detail = 'system_activity_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger activities_system_immutable before update or delete on app.activities
  for each row execute function private.forbid_system_activity_change();

-- ---------- files ----------
create table app.files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  record_type app.record_type not null,
  record_id uuid not null,
  bucket text not null default 'attachments',
  object_path text not null unique,
  name text not null check (length(name) between 1 and 200),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  status app.file_status not null default 'pending',
  created_by uuid references app.users (id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index files_record_idx on app.files (workspace_id, record_type, record_id, created_at desc) where deleted_at is null and status = 'ready';
create index files_pending_idx on app.files (created_at) where status = 'pending' and deleted_at is null;
create trigger files_updated_at before update on app.files for each row execute function private.set_updated_at();
create trigger files_immutable before update on app.files for each row execute function private.forbid_tenant_column_change('workspace_id', 'record_type', 'record_id', 'bucket', 'object_path', 'created_by');

-- ---------- archive guard: only records.archive holders (or the worker in scope) change archived_at ----------
create or replace function private.guard_archive()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.archived_at is distinct from new.archived_at then
    -- coalesce: the scope helper is null for humans and null never satisfies an IF.
    if not (coalesce(private.has_permission(new.workspace_id, 'records.archive'), false) or coalesce(private.system_scope_workspace() = new.workspace_id, false)) then
      raise exception 'Archiving needs the records.archive permission' using errcode = '42501', detail = 'archive_forbidden';
    end if;
    new.archived_by := case when new.archived_at is null then null else coalesce(auth.uid(), new.archived_by) end;
  end if;
  return new;
end $$;
create trigger people_archive_guard before update on app.people for each row execute function private.guard_archive();
create trigger companies_archive_guard before update on app.companies for each row execute function private.guard_archive();
create trigger leads_archive_guard before update on app.leads for each row execute function private.guard_archive();

-- ---------- default pipeline for every workspace ----------
create or replace function private.ensure_default_pipeline(p_workspace uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_pipeline uuid;
begin
  select p.id into v_pipeline from app.pipelines p where p.workspace_id = p_workspace and p.archived_at is null order by p.position, p.created_at limit 1;
  if v_pipeline is not null then return v_pipeline; end if;
  insert into app.pipelines (workspace_id, name, position) values (p_workspace, 'Sales', 0) returning id into v_pipeline;
  insert into app.pipeline_stages (workspace_id, pipeline_id, name, kind, position) values
    (p_workspace, v_pipeline, 'New', 'open', 1),
    (p_workspace, v_pipeline, 'Contacted', 'open', 2),
    (p_workspace, v_pipeline, 'Estimate sent', 'open', 3),
    (p_workspace, v_pipeline, 'Won', 'won', 4),
    (p_workspace, v_pipeline, 'Lost', 'lost', 5);
  return v_pipeline;
end $$;

create or replace function private.handle_workspace_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.ensure_default_pipeline(new.id);
  return new;
end $$;
create trigger on_workspace_created after insert on app.workspaces
  for each row execute function private.handle_workspace_created();

-- Backfill workspaces that existed before this migration.
do $$
declare w record;
begin
  for w in select id from app.workspaces loop
    perform private.ensure_default_pipeline(w.id);
  end loop;
end $$;

-- ---------- grants (RLS policies arrive in 0007) ----------
grant select, insert, update on app.pipelines, app.companies, app.people, app.tags, app.leads, app.tasks, app.activities, app.files, app.imports to authenticated;
grant select, insert, update, delete on app.pipeline_stages, app.record_tags to authenticated;
grant delete on app.tags, app.tasks, app.activities to authenticated;
grant select on app.import_errors to authenticated;

grant select on app.pipelines, app.pipeline_stages, app.leads, app.tasks, app.tags, app.record_tags to service_actor;
grant select, insert, update on app.companies, app.people, app.activities, app.imports to service_actor;
grant select, insert on app.import_errors to service_actor;
grant select, update, delete on app.files to service_actor;

revoke all on all tables in schema app from anon;
revoke all on all functions in schema private from public;
grant execute on function
  private.check_stage_pipeline(), private.check_pipeline_stage_kinds(), private.forbid_stage_kind_change(),
  private.check_person_company(), private.sync_lead_status(), private.forbid_system_activity_change(),
  private.guard_archive(), private.ensure_default_pipeline(uuid), private.handle_workspace_created()
  to authenticated, service_actor;
