-- =============================================================================
-- 0076 · Fields a business invents (M15). Every business keeps something the
--        product never thought of: a gate code, a pool size, a preferred day, a
--        purchase-order number. Until now a form answer with nowhere to go
--        stayed on the response, which meant the business could read it one
--        answer at a time but never ask "which customers have a gate code?".
--        Chris chose (2026-09-18) to give them real fields instead.
--
--        Two decisions worth writing down. The definitions live in their own
--        table, so a field can be renamed, reordered or retired without
--        touching a single customer. The values live in a `custom` JSON object
--        on the record itself, keyed by field id — not in a values table —
--        because a customer and their fields are one thing to read, one thing
--        to write, and one thing to sync to a phone that is offline (M10). A
--        GIN index is what keeps "everyone whose gate code is set" quick.
--
--        Keyed by field id, never by name, for the same reason questions carry
--        ids: rename "Gate code" to "Access code" and every customer keeps
--        their answer.
--
--        fields.manage (owners, admins) makes and retires them; anyone who can
--        write a record can fill them in.
-- =============================================================================

create type app.custom_field_entity as enum ('person', 'company', 'lead');
create type app.custom_field_type as enum (
  'text', 'long_text', 'number', 'money', 'date', 'choice', 'multi_choice', 'boolean', 'phone', 'email', 'url');

create table app.custom_fields (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  entity app.custom_field_entity not null,
  -- The short name used in imports, exports and the API ('gate_code'). Unique per entity, and never reused
  -- while the field lives.
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (length(btrim(label)) between 1 and 60),
  type app.custom_field_type not null default 'text',
  -- Choice and multi-choice: [{"value": "...", "label": "..."}]. Empty for every other type.
  options jsonb not null default '[]'::jsonb
    check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 100),
  -- The smaller line under it on the record.
  help text not null default '' check (length(help) <= 200),
  -- Where it sits on the record, lowest first.
  position integer not null default 0 check (position between 0 and 1000),
  -- Shown on the record even when empty, rather than only once it has something in it.
  always_show boolean not null default false,
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, entity, key),
  check ((type in ('choice', 'multi_choice')) or jsonb_array_length(options) = 0),
  check ((type not in ('choice', 'multi_choice')) or jsonb_array_length(options) between 1 and 100)
);
create index custom_fields_list_idx on app.custom_fields (workspace_id, entity, position, label)
  where archived_at is null;
create index custom_fields_created_by_idx on app.custom_fields (created_by);
create trigger custom_fields_updated_at before update on app.custom_fields
  for each row execute function private.set_updated_at();
create trigger custom_fields_immutable before update on app.custom_fields
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'entity', 'created_by');

-- A business keeps this many fields per record type. A wall, not a wish: the values travel inside the
-- record, and a record that has to be read on a phone in a driveway should stay small.
create or replace function private.custom_field_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.custom_fields f
  where f.workspace_id = new.workspace_id and f.entity = new.entity and f.archived_at is null;
  if v_count > 50 then
    raise exception 'That is as many fields as a record can carry (50)'
      using errcode = '23514', detail = 'too_many_custom_fields';
  end if;
  return null;
end $$;
create constraint trigger custom_fields_room after insert or update on app.custom_fields
  deferrable initially deferred for each row execute function private.custom_field_room();

-- ---------- the values, on the record itself ----------
alter table app.people add column custom jsonb not null default '{}'::jsonb
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 16384);
alter table app.companies add column custom jsonb not null default '{}'::jsonb
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 16384);
alter table app.leads add column custom jsonb not null default '{}'::jsonb
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 16384);

-- "Everyone whose gate code is set", and "everyone whose preferred day is Tuesday".
create index people_custom_idx on app.people using gin (custom jsonb_path_ops);
create index companies_custom_idx on app.companies using gin (custom jsonb_path_ops);
create index leads_custom_idx on app.leads using gin (custom jsonb_path_ops);

-- Every key is a field this business actually has, for this kind of record. Core checks the value against
-- the field's type before it writes; this is the line nothing crosses, whoever is writing.
create or replace function private.check_custom_values()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_entity app.custom_field_entity := tg_argv[0]::app.custom_field_entity;
  v_stray text;
begin
  if new.custom = '{}'::jsonb or (tg_op = 'UPDATE' and new.custom = old.custom) then
    return new;
  end if;
  select k into v_stray from jsonb_object_keys(new.custom) as k
  where not exists (
    select 1 from app.custom_fields f
    where f.workspace_id = new.workspace_id and f.entity = v_entity and f.archived_at is null
      and f.id::text = k)
  limit 1;
  if v_stray is not null then
    raise exception 'There is no field % on this record', v_stray
      using errcode = '23514', detail = 'unknown_custom_field';
  end if;
  return new;
end $$;
create trigger people_check_custom before insert or update of custom on app.people
  for each row execute function private.check_custom_values('person');
create trigger companies_check_custom before insert or update of custom on app.companies
  for each row execute function private.check_custom_values('company');
create trigger leads_check_custom before insert or update of custom on app.leads
  for each row execute function private.check_custom_values('lead');

-- Retiring a field leaves the values where they are (nothing is quietly deleted from a customer), but the
-- trigger above would then refuse the next save of that record. So retiring clears the key from the records
-- that hold it, once, deliberately.
create or replace function private.clear_retired_custom_field()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null or old.archived_at is not null then
    return new;
  end if;
  if new.entity = 'person' then
    update app.people set custom = custom - new.id::text
      where workspace_id = new.workspace_id and custom ? new.id::text;
  elsif new.entity = 'company' then
    update app.companies set custom = custom - new.id::text
      where workspace_id = new.workspace_id and custom ? new.id::text;
  else
    update app.leads set custom = custom - new.id::text
      where workspace_id = new.workspace_id and custom ? new.id::text;
  end if;
  return new;
end $$;
create trigger custom_fields_clear_on_retire after update of archived_at on app.custom_fields
  for each row execute function private.clear_retired_custom_field();

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'fields.manage'), ('admin', 'fields.manage');

-- ---------- RLS: everyone sees what the fields are; owners and admins decide what they are ----------
alter table app.custom_fields enable row level security;

create policy custom_fields_select on app.custom_fields for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy custom_fields_insert on app.custom_fields for insert to authenticated
  with check (private.has_permission(workspace_id, 'fields.manage') and created_by = (select auth.uid())
    and archived_at is null);
create policy custom_fields_update on app.custom_fields for update to authenticated
  using (private.has_permission(workspace_id, 'fields.manage'))
  with check (private.has_permission(workspace_id, 'fields.manage'));
create policy custom_fields_service_all on app.custom_fields for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.custom_fields to authenticated;
grant update (label, type, options, help, position, always_show, archived_at, updated_at)
  on app.custom_fields to authenticated;
grant select, insert, update on app.custom_fields to service_actor;

revoke all on function private.check_custom_values(), private.clear_retired_custom_field(),
  private.custom_field_room() from public, authenticated, anon;
