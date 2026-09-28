-- =============================================================================
-- What an add-on owns: its queued work, its kinds of records, what it holds
-- outside HandsFreeOS, what it counts, and its own tables.
--
--        Everything an add-on leaves in the database says so, so turning it
--        off, uninstalling it and deleting its data are statements about rows
--        the database can find, and "nothing is left behind" is a query
--        (docs/addon-architecture.md, 0108):
--
--        - **Queued work.** app.scheduled_jobs and app.webhook_deliveries
--          gain the add-on (and, for jobs, its generation), so turning it off
--          cancels its work in one statement and a job queued before a
--          reinstall never runs. app.events and app.audit_logs gain it too:
--          history says which add-on did what, and its details can be taken
--          out when its data is permanently deleted.
--        - **Its kinds of records.** An add-on's things (a Property, a Lease)
--          are custom records of a kind it manages (0101), so the timeline,
--          tasks, files, appointments, relationships, fields and search all
--          work on them unchanged, and core never holds a foreign key into an
--          add-on's tables. A managed kind is written only by its add-on's
--          permission, doesn't count against a business's 30 kinds, and its
--          records are hidden from people while the add-on is off (the
--          owner's decision, 2026-09-28: hidden until it's back on).
--        - **What it holds outside.** app.addon_resources lists what an add-on
--          made at a provider (a webhook subscription, a connected account),
--          so uninstalling can release each one and prove none is left.
--        - **What it counts.** app.addon_usage_events: idempotent usage, per
--          add-on and meter, refused while the add-on is off. Prices are
--          never here; billing can be built on top later.
--        - **Its own tables** live in its own schema, `addon_<id>`, so what it
--          owns is everything in that schema. private.addon_table_policies()
--          gives one the rules every tenant table has in one call; the
--          catalogue tests check each one has them.
-- =============================================================================

-- ---------- queued work and history say which add-on ----------
alter table app.scheduled_jobs
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  add column addon_generation integer check (addon_generation is null or addon_generation >= 1),
  -- An add-on's work is always one business's: it is cancelled, and checked, per business.
  add constraint scheduled_jobs_addon_owner_check check (
    (addon_id is null) = (addon_generation is null) and (addon_id is null or workspace_id is not null));
create index scheduled_jobs_addon_pending_idx on app.scheduled_jobs (workspace_id, addon_id)
  where status = 'pending' and addon_id is not null;

alter table app.webhook_deliveries
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  add constraint webhook_deliveries_addon_owner_check check (addon_id is null or workspace_id is not null);
create index webhook_deliveries_addon_pending_idx on app.webhook_deliveries (workspace_id, addon_id)
  where status = 'pending' and addon_id is not null;

alter table app.events add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$');
create index events_addon_idx on app.events (workspace_id, addon_id) where addon_id is not null;
alter table app.audit_logs add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$');
create index audit_logs_addon_idx on app.audit_logs (workspace_id, addon_id) where addon_id is not null;

-- The worker's add-on functions act for the one business its transaction is scoped to, like its row policies.
create or replace function private.assert_worker_scope(p_ws uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_ws is null or p_ws is distinct from private.system_scope_workspace() then
    raise exception 'The worker changes an add-on only in the business it is scoped to' using errcode = '42501';
  end if;
end $$;

-- Whether a piece of an add-on's queued work may run now: the add-on is on in its business, HandsFreeOS hasn't
-- switched it off, and (for a job) the job was queued for the generation installed now, not before a reinstall.
-- The job and webhook runners ask this before every add-on item they claim, from their unscoped claiming
-- transaction; it answers only yes or no.
create or replace function private.addon_runs_now(p_ws uuid, p_addon text, p_generation integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from app.addon_installations i
      where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'enabled'
        and (p_generation is null or i.generation = p_generation))
    and not exists (select 1 from platform.addon_overrides o where o.addon_id = p_addon and o.status = 'unavailable')
$$;

-- Everything an add-on has queued in one business, stopped: its jobs cancelled, its provider messages set aside.
-- A job that is running now keeps running to its end but can't put itself back (its lease is gone), and the job
-- runner re-checks the add-on before every job anyway. Returns how many of each.
create or replace function private.addon_cancel_work(p_ws uuid, p_addon text)
returns table (jobs integer, deliveries integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_jobs integer;
  v_deliveries integer;
begin
  perform private.assert_worker_scope(p_ws);
  update app.scheduled_jobs j set status = 'cancelled', finished_at = now(), locked_at = null, locked_by = null,
    last_error = 'addon_inactive'
  where j.workspace_id = p_ws and j.addon_id = p_addon and j.status = 'pending';
  get diagnostics v_jobs = row_count;
  update app.webhook_deliveries d set status = 'ignored', processed_at = now(), locked_at = null, locked_by = null,
    last_error = 'addon_inactive'
  where d.workspace_id = p_ws and d.addon_id = p_addon and d.status = 'pending';
  get diagnostics v_deliveries = row_count;
  return query select v_jobs, v_deliveries;
end $$;

-- ---------- kinds of records an add-on manages ----------
alter table app.custom_record_types
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  -- Who may add or change one of its records: the add-on's own permission. Reading follows records.read.
  add column write_permission text check (write_permission is null or write_permission ~ '^[a-z_]+(\.[a-z_]+)+$'),
  add constraint custom_record_types_addon_check check ((addon_id is null) = (write_permission is null));
create index custom_record_types_addon_idx on app.custom_record_types (workspace_id, addon_id)
  where addon_id is not null;
-- A business's own "Property" and an add-on's may both exist: names and keys are unique among a business's own
-- kinds, and among each add-on's. (A kind's key is only ever looked up alongside its add-on, so a groomer's own
-- `pet_profile` never stops a `pet` add-on from installing its own.)
alter table app.custom_record_types drop constraint custom_record_types_workspace_id_key_key;
create unique index custom_record_types_key_unique on app.custom_record_types (workspace_id, key)
  where addon_id is null;
create unique index custom_record_types_addon_key_unique on app.custom_record_types (workspace_id, addon_id, key)
  where addon_id is not null;
drop index app.custom_record_types_name_unique;
create unique index custom_record_types_name_unique on app.custom_record_types (workspace_id, lower(btrim(singular)))
  where archived_at is null and addon_id is null;
create unique index custom_record_types_addon_name_unique
  on app.custom_record_types (workspace_id, addon_id, lower(btrim(singular)))
  where archived_at is null and addon_id is not null;

alter table app.relationship_types
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  -- The type's key in its add-on's manifest (`pm_tenant`), so reinstalling finds it again.
  add column addon_key text check (addon_key is null or addon_key ~ '^[a-z]{2,16}_[a-z][a-z0-9_]{0,38}$'),
  add constraint relationship_types_addon_check check ((addon_id is null) = (addon_key is null));
create unique index relationship_types_addon_key_unique on app.relationship_types (workspace_id, addon_key)
  where addon_key is not null;
drop index app.relationship_types_unique;
create unique index relationship_types_unique on app.relationship_types (
  workspace_id, coalesce(addon_id, ''),
  a_end, coalesce(a_record_type_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(a_label)),
  b_end, coalesce(b_record_type_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(b_label))
) where archived_at is null;

-- A record whose add-on's data was permanently deleted: its name stays, so what pointed at it still reads
-- ("Property: 12 Main St"), and nothing else about it does.
alter table app.custom_records add column purged_at timestamptz;

-- Managed kinds and types don't count against a business's own limits (30 kinds, 50 types).
create or replace function private.custom_record_type_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.custom_record_types t
  where t.workspace_id = new.workspace_id and t.archived_at is null and t.addon_id is null;
  if v_count > 30 then
    raise exception 'That is as many kinds of records as a business can keep (30)'
      using errcode = '23514', detail = 'too_many_record_types';
  end if;
  return null;
end $$;
create or replace function private.relationship_type_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.relationship_types t
  where t.workspace_id = new.workspace_id and t.archived_at is null and t.addon_id is null;
  if v_count > 50 then
    raise exception 'That is as many relationship types as a business can keep (50)'
      using errcode = '23514', detail = 'too_many_relationship_types';
  end if;
  return null;
end $$;

-- Which add-on manages a kind, and the permission its records are written with, whoever is asking.
create or replace function private.record_kind_owner(p_type uuid)
returns table (addon_id text, write_permission text)
language sql stable security definer set search_path = '' as $$
  select t.addon_id, t.write_permission from app.custom_record_types t where t.id = p_type
$$;

-- The managed kinds a person may not see now: those of add-ons that don't run in their businesses. Asked once per
-- query, as the set-based permission helpers are (PERF-M6).
create or replace function private.hidden_record_kinds()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select t.id from app.custom_record_types t
  where t.addon_id is not null
    and t.workspace_id in (select private.accessible_workspace_ids())
    and not (t.addon_id = any (private.running_addons(t.workspace_id)))
$$;

-- A person's own writes to kinds and types an add-on manages: never making one, never moving what it is or whether
-- it shows (its add-on decides that). Relabelling is theirs. Not security definer: it asks who is writing.
create or replace function private.guard_managed_kind()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.addon_id is not null then
      raise exception 'Only its add-on makes this' using errcode = '42501', detail = 'managed_by_addon';
    end if;
    return new;
  end if;
  if new.addon_id is distinct from old.addon_id
     or (old.addon_id is not null and new.archived_at is distinct from old.archived_at) then
    raise exception 'Its add-on decides this' using errcode = '42501', detail = 'managed_by_addon';
  end if;
  -- Nested, not joined with AND: PL/pgSQL compiles a whole condition against the row it has, and each table has
  -- a column the other lacks.
  if tg_table_name = 'custom_record_types' then
    if new.write_permission is distinct from old.write_permission then
      raise exception 'Its add-on decides this' using errcode = '42501', detail = 'managed_by_addon';
    end if;
  elsif old.addon_id is not null then
    if new.cardinality is distinct from old.cardinality or new.addon_key is distinct from old.addon_key then
      raise exception 'Its add-on decides this' using errcode = '42501', detail = 'managed_by_addon';
    end if;
  end if;
  return new;
end $$;
create trigger custom_record_types_managed before insert or update on app.custom_record_types
  for each row execute function private.guard_managed_kind();
create trigger relationship_types_managed before insert or update on app.relationship_types
  for each row execute function private.guard_managed_kind();

-- A person's writes to a record of a managed kind: only while its add-on runs, only with its write permission, and
-- never to one whose data was deleted.
create or replace function private.guard_managed_record()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_addon text;
  v_permission text;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.purged_at is not null then
    raise exception 'This record''s add-on data was deleted' using errcode = '42501', detail = 'record_purged';
  end if;
  select o.addon_id, o.write_permission into v_addon, v_permission from private.record_kind_owner(new.type_id) o;
  if v_addon is null then
    return new;
  end if;
  if not private.addon_in_use(new.workspace_id, v_addon, false) then
    raise exception 'That add-on isn''t on here' using errcode = '42501', detail = 'addon_inactive';
  end if;
  if not private.has_permission(new.workspace_id, v_permission) then
    raise exception 'You can''t change these records' using errcode = '42501', detail = 'managed_record_forbidden';
  end if;
  return new;
end $$;
create trigger custom_records_managed before insert or update on app.custom_records
  for each row execute function private.guard_managed_record();

-- Hidden until it's back on: a person doesn't see the records of a managed kind while its add-on is off.
drop policy custom_records_select on app.custom_records;
create policy custom_records_select on app.custom_records for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and type_id not in (select private.hidden_record_kinds()));
drop policy custom_record_types_select on app.custom_record_types;
create policy custom_record_types_select on app.custom_record_types for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and id not in (select private.hidden_record_kinds()));

-- An add-on's kinds and types shown or hidden with it, the way archiving a kind already hides the types on it and
-- restoring brings back exactly those (0101): one moment for all of them, so showing restores that moment's set.
create or replace function private.addon_hide_records(p_ws uuid, p_addon text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz := now();
  v_kinds uuid[];
  v_n integer;
begin
  perform private.assert_worker_scope(p_ws);
  select coalesce(array_agg(t.id), '{}') into v_kinds from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is null;
  update app.custom_record_types t set archived_at = v_at where t.id = any (v_kinds);
  get diagnostics v_n = row_count;
  update app.relationship_types r set archived_at = v_at
  where r.workspace_id = p_ws and r.archived_at is null
    and (r.addon_id = p_addon or r.a_record_type_id = any (v_kinds) or r.b_record_type_id = any (v_kinds));
  return v_n;
end $$;

create or replace function private.addon_show_records(p_ws uuid, p_addon text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_kind record;
  v_n integer := 0;
begin
  perform private.assert_worker_scope(p_ws);
  for v_kind in select t.id, t.archived_at from app.custom_record_types t
      where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is not null loop
    update app.relationship_types r set archived_at = null
    where r.workspace_id = p_ws and r.archived_at = v_kind.archived_at
      and (r.addon_id = p_addon or r.a_record_type_id = v_kind.id or r.b_record_type_id = v_kind.id);
    update app.custom_record_types t set archived_at = null where t.id = v_kind.id;
    v_n := v_n + 1;
  end loop;
  -- Types it manages between core records only (a person to a company) come back with it too.
  update app.relationship_types r set archived_at = null
  where r.workspace_id = p_ws and r.addon_id = p_addon and r.archived_at is not null
    and r.a_record_type_id is null and r.b_record_type_id is null;
  return v_n;
end $$;

-- ---------- what an add-on holds outside HandsFreeOS ----------
create table app.addon_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  generation integer not null check (generation >= 1),
  -- `<addon>.<kind>`, as its manifest's `resources` lists it: 'social.page_subscription'.
  kind text not null check (kind ~ '^[a-z]{2,16}(\.[a-z][a-z_]*)+$'),
  -- The provider's id for it, so it can be released there.
  external_id text not null check (length(external_id) between 1 and 500),
  label text check (label is null or length(label) <= 200),
  status text not null default 'active' check (status in ('active', 'released', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) <= 2000),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'released') = (released_at is not null))
);
create unique index addon_resources_live_unique on app.addon_resources (workspace_id, addon_id, kind, external_id)
  where status <> 'released';
create index addon_resources_held_idx on app.addon_resources (workspace_id, addon_id) where status <> 'released';
create trigger addon_resources_updated_at before update on app.addon_resources
  for each row execute function private.set_updated_at();
create trigger addon_resources_immutable before update on app.addon_resources
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'addon_id', 'kind', 'external_id');
alter table app.addon_resources enable row level security;
create policy addon_resources_select on app.addon_resources for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('addons.manage')));
create policy addon_resources_service_all on app.addon_resources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.addon_resources to authenticated;
grant select, insert, update, delete on app.addon_resources to service_actor;
revoke all on app.addon_resources from anon;

-- ---------- what an add-on counts ----------
create table app.addon_usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  -- `<addon>.<meter>`, as its manifest's billing.meters lists it.
  meter text not null check (meter ~ '^[a-z]{2,16}(\.[a-z][a-z_]*)+$'),
  quantity numeric not null check (quantity > 0),
  -- The same key twice is the same usage once: retries never count twice.
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index addon_usage_events_meter_idx on app.addon_usage_events (workspace_id, addon_id, meter, occurred_at);
create trigger addon_usage_events_append_only before update or delete on app.addon_usage_events
  for each row execute function private.forbid_change();
alter table app.addon_usage_events enable row level security;
create policy addon_usage_events_select on app.addon_usage_events for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('addons.manage')));
create policy addon_usage_events_service_select on app.addon_usage_events for select to service_actor
  using (workspace_id = private.system_scope_workspace());
grant select on app.addon_usage_events to authenticated, service_actor;
revoke all on app.addon_usage_events from anon;

-- Usage recorded while an add-on runs, and only then: an add-on that is off counts nothing. The meter must be the
-- add-on's own. Returns false when the key was already counted.
create or replace function private.record_addon_usage(
  p_ws uuid, p_addon text, p_meter text, p_quantity numeric, p_key text, p_at timestamptz default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not p_meter like p_addon || '.%' then
    raise exception 'A meter belongs to its add-on' using errcode = '23514', detail = 'addon_meter_not_its_own';
  end if;
  if not private.addon_in_use(p_ws, p_addon, false) then
    raise exception 'That add-on isn''t on here' using errcode = '42501', detail = 'addon_inactive';
  end if;
  insert into app.addon_usage_events (workspace_id, addon_id, meter, quantity, idempotency_key, occurred_at)
  values (p_ws, p_addon, p_meter, p_quantity, p_key, coalesce(p_at, now()))
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

-- ---------- an add-on's own tables ----------
-- The schema an add-on's tables live in, with the usage the app roles need. Its migration calls this first.
create or replace function private.create_addon_schema(p_addon text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_addon !~ '^[a-z]{2,16}$' then
    raise exception 'An add-on id is 2 to 16 lowercase letters' using errcode = '23514';
  end if;
  execute format('create schema if not exists %I', 'addon_' || p_addon);
  execute format('revoke all on schema %I from public', 'addon_' || p_addon);
  execute format('grant usage on schema %I to authenticated, service_actor', 'addon_' || p_addon);
end $$;

-- Whether the worker may write an add-on's rows here: while it runs, and while it is arriving (its data migrations).
create or replace function private.addon_writable(p_ws uuid, p_addon text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon and i.state in ('enabled', 'installing')
      and not exists (select 1 from platform.addon_overrides o where o.addon_id = p_addon and o.status = 'unavailable'))
$$;

-- Everything a tenant table has, for one of an add-on's tables, in one call from its migration:
-- - row security: people read where they hold the add-on's read permission (asked once per query, PERF-M6) and
--   write where they hold its write permission — both of which exist only while the add-on runs (0108);
-- - the worker bound to the one business it works for, and able to write only while the add-on runs or arrives,
--   while still able to read and delete (to export and purge) after it's gone;
-- - updated_at kept, the tenant column frozen, and the grants, with nothing for anon.
-- The table must have `workspace_id uuid not null references app.workspaces (id) on delete cascade`; the catalogue
-- test (packages/db/test/addons-rls.test.ts) checks every add-on table was made this way.
create or replace function private.addon_table_policies(
  p_table regclass, p_read text, p_write text, p_delete text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_schema text;
  v_name text;
  v_addon text;
  v_read text;
  v_write text;
begin
  select n.nspname, c.relname into v_schema, v_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_schema !~ '^addon_[a-z]{2,16}$' then
    raise exception '% is not in an add-on''s schema', p_table using errcode = '23514';
  end if;
  v_addon := substr(v_schema, 7);
  if p_read not like v_addon || '.%' or p_write not like v_addon || '.%'
     or (p_delete is not null and p_delete not like v_addon || '.%') then
    raise exception 'An add-on''s table is guarded by the add-on''s own permissions' using errcode = '23514';
  end if;
  if not exists (
      select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'workspace_id'
        and a.attnotnull and not a.attisdropped) then
    raise exception '% needs workspace_id uuid not null', p_table using errcode = '23514';
  end if;
  v_read := format('workspace_id in (select private.workspaces_with_permission(%L))', p_read);
  v_write := format('workspace_id in (select private.workspaces_with_permission(%L))', p_write);
  execute format('alter table %s enable row level security', p_table);
  execute format('create policy %I on %s for select to authenticated using (%s)', v_name || '_select', p_table, v_read);
  execute format('create policy %I on %s for insert to authenticated with check (%s)', v_name || '_insert', p_table, v_write);
  execute format('create policy %I on %s for update to authenticated using (%s) with check (%s)',
    v_name || '_update', p_table, v_write, v_write);
  if p_delete is not null then
    execute format('create policy %I on %s for delete to authenticated using (%s)', v_name || '_delete', p_table,
      format('workspace_id in (select private.workspaces_with_permission(%L))', p_delete));
  end if;
  execute format(
    'create policy %I on %s for all to service_actor using (workspace_id = private.system_scope_workspace()) '
    'with check (workspace_id = private.system_scope_workspace() and private.addon_writable(workspace_id, %L))',
    v_name || '_service_all', p_table, v_addon);
  if exists (select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'updated_at' and not a.attisdropped) then
    execute format('create trigger %I before update on %s for each row execute function private.set_updated_at()',
      v_name || '_updated_at', p_table);
  end if;
  execute format(
    'create trigger %I before update on %s for each row execute function private.forbid_tenant_column_change(%L)',
    v_name || '_immutable', p_table, 'workspace_id');
  execute format('grant select, insert, update%s on %s to authenticated',
    case when p_delete is not null then ', delete' else '' end, p_table);
  execute format('grant select, insert, update, delete on %s to service_actor', p_table);
  execute format('revoke all on %s from anon', p_table);
end $$;

revoke all on function private.assert_worker_scope(uuid), private.addon_runs_now(uuid, text, integer),
  private.addon_cancel_work(uuid, text), private.record_kind_owner(uuid),
  private.hidden_record_kinds(), private.addon_hide_records(uuid, text), private.addon_show_records(uuid, text),
  private.record_addon_usage(uuid, text, text, numeric, text, timestamptz), private.create_addon_schema(text),
  private.addon_writable(uuid, text), private.addon_table_policies(regclass, text, text, text)
  from public;
grant execute on function private.record_kind_owner(uuid), private.hidden_record_kinds()
  to authenticated, service_actor;
-- The worker's own policies ask it; a person has no business asking about another's add-ons.
grant execute on function private.addon_writable(uuid, text) to service_actor;
grant execute on function private.assert_worker_scope(uuid), private.addon_runs_now(uuid, text, integer),
  private.addon_cancel_work(uuid, text), private.addon_hide_records(uuid, text),
  private.addon_show_records(uuid, text) to service_actor;
grant execute on function private.record_addon_usage(uuid, text, text, numeric, text, timestamptz)
  to authenticated, service_actor;
