-- =============================================================================
-- What a customer signed in to their portal may read (Real Estate round two,
-- step 3; core, for every portal).
--
--        A new role, `portal_actor`, that only the worker can become. The
--        worker's kernel switches to it for a customer's look-ups, with the
--        signed-in device's session id in `app.portal.session_id`. Every rule
--        below asks the database who that is: the session must still be
--        live (not signed out, access not turned off, used in the last 30
--        days, under 90 days old), so a device signed out mid-request sees
--        nothing from then on. Nothing here can write; a customer's changes
--        run through the kernel as the service actor, recorded as theirs.
--
--        What a customer sees:
--        - themselves (a few columns of their own person row), and the
--          business's name;
--        - the records they're on through a relationship type its add-on
--          marked `portal_visible` (a Real Estate client and their deals),
--          while that add-on is on: `portal.records()`;
--        - an add-on's own rows about those records, where its migration
--          says so with `private.addon_portal_policies(...)`, and only the
--          columns it names.
--
--        Customers are the least trusted of anyone HandsFreeOS serves, so
--        the role reaches only `app` (what is granted it there) and its own
--        small schema, `portal`: never `private`, whose helpers are written
--        for people who work in a business.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'portal_actor') then
    create role portal_actor nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
grant portal_actor to hfos_worker;
grant usage on schema app to portal_actor;
grant usage on schema extensions to portal_actor;

create schema if not exists portal;
revoke all on schema portal from public;
grant usage on schema portal to portal_actor;
comment on schema portal is 'What a customer signed in to their portal asks of the database: who they are, and what is theirs.';

-- ---------- which relationships show a record to the customer on it ----------
alter table app.relationship_types add column portal_visible boolean not null default false;
-- Only an add-on's own types, between a customer and one of its records: a business can't open its records yet.
alter table app.relationship_types add constraint relationship_types_portal_check check (
  not portal_visible or (addon_id is not null and not mutual and (
    (a_end = 'person' and b_end = 'custom_record') or (a_end = 'custom_record' and b_end = 'person'))));
comment on column app.relationship_types.portal_visible is
  'The customer at the person end sees the record in their portal (an add-on''s manifest says so).';

-- ---------- who is asking ----------
-- The signed-in device this transaction is for, if it is still signed in. Only under portal_actor.
create or replace function portal.session()
returns table (person_id uuid, workspace_id uuid) language sql stable security definer set search_path = '' as $$
  select s.person_id, s.workspace_id
  from app.portal_sessions s join app.portal_access a on a.id = s.access_id
  where current_setting('role', true) = 'portal_actor'
    and s.id = nullif(current_setting('app.portal.session_id', true), '')::uuid
    and s.ended_at is null and a.revoked_at is null
    and s.expires_at > now() and s.last_seen_at > now() - interval '30 days'
$$;

create or replace function portal.person()
returns uuid language sql stable security definer set search_path = '' as $$
  select person_id from portal.session()
$$;

create or replace function portal.workspace()
returns uuid language sql stable security definer set search_path = '' as $$
  select workspace_id from portal.session()
$$;

-- For the worker running a customer's command: the session it was handed, if still signed in, and whose it is.
create or replace function private.portal_session_live(p_session uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.person_id
  from app.portal_sessions s join app.portal_access a on a.id = s.access_id
  where s.id = p_session and s.workspace_id = private.system_scope_workspace()
    and s.ended_at is null and a.revoked_at is null
    and s.expires_at > now() and s.last_seen_at > now() - interval '30 days'
$$;

-- The records a customer is on through a portal-visible relationship, while the add-on that keeps them is on. Only
-- in the business the asker is scoped to: the worker's, or the customer's own.
create or replace function private.portal_records_for(p_ws uuid, p_person uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id
  from app.relationships rel
  join app.relationship_types t on t.id = rel.type_id and t.portal_visible and t.archived_at is null
  join app.custom_records r on r.id = coalesce(rel.a_custom_record_id, rel.b_custom_record_id)
  join app.custom_record_types k on k.id = r.type_id
  where rel.workspace_id = p_ws and p_person is not null
    and p_ws = coalesce(private.system_scope_workspace(), portal.workspace())
    and p_person in (rel.a_person_id, rel.b_person_id)
    and r.workspace_id = p_ws and r.purged_at is null
    and k.addon_id = any (private.running_addons(p_ws))
$$;

-- The same, for the customer asking (once per query in a policy: `x in (select portal.records())`).
create or replace function portal.records()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select private.portal_records_for(s.workspace_id, s.person_id) from portal.session() s
$$;

-- The kernel's add-on check for a customer's look-ups: whether this add-on runs in their business.
create or replace function portal.addon_in_use(p_addon text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_addon = any (private.running_addons(portal.workspace())), false)
$$;

revoke all on function portal.session(), portal.person(), portal.workspace(), portal.records(),
  portal.addon_in_use(text), private.portal_session_live(uuid), private.portal_records_for(uuid, uuid) from public;
grant execute on function portal.session(), portal.person(), portal.workspace(), portal.records(),
  portal.addon_in_use(text) to portal_actor;
grant execute on function private.portal_session_live(uuid), private.portal_records_for(uuid, uuid)
  to service_actor;

-- ---------- what of core's they read ----------
create policy people_portal_select on app.people for select to portal_actor
  using (id = (select portal.person()));
grant select (id, workspace_id, first_name, last_name, email, phone) on app.people to portal_actor;

create policy workspaces_portal_select on app.workspaces for select to portal_actor
  using (id = (select portal.workspace()));
grant select (id, name) on app.workspaces to portal_actor;

create policy custom_records_portal_select on app.custom_records for select to portal_actor
  using (id in (select portal.records()));
grant select (id, workspace_id, type_id, name, archived_at, created_at, updated_at) on app.custom_records
  to portal_actor;

create policy custom_record_types_portal_select on app.custom_record_types for select to portal_actor
  using (workspace_id = (select portal.workspace()) and addon_id is not null);
grant select (id, workspace_id, key, singular, plural, addon_id) on app.custom_record_types to portal_actor;

-- ---------- an add-on's own rows ----------
-- What a customer reads of an add-on table about its records (a deal's dates, its homes): the rows about the
-- records they're on, and only the columns named (workspace_id and the record column always). Select only.
create or replace function private.addon_portal_policies(
  p_table regclass, p_record_column name, p_columns name[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_schema text;
  v_name text;
  v_columns name[];
  v_column name;
begin
  select n.nspname, c.relname into v_schema, v_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table;
  if v_schema !~ '^addon_[a-z]{2,16}$' then
    raise exception '% is not in an add-on''s schema', p_table using errcode = '23514';
  end if;
  if not exists (
      select 1 from pg_attribute a where a.attrelid = p_table and a.attname = 'workspace_id'
        and a.attnotnull and not a.attisdropped) then
    raise exception '% needs workspace_id uuid not null', p_table using errcode = '23514';
  end if;
  if not exists (
      select 1 from pg_attribute a where a.attrelid = p_table and a.attname = p_record_column
        and not a.attisdropped and a.atttypid = 'uuid'::regtype) then
    raise exception '% has no uuid column %', p_table, p_record_column using errcode = '23514';
  end if;
  if p_columns is null or cardinality(p_columns) = 0 then
    raise exception 'Name the columns a customer may read of %', p_table using errcode = '23514';
  end if;
  v_columns := array(select distinct c from unnest(array['workspace_id', p_record_column] || p_columns) c);
  foreach v_column in array v_columns loop
    if not exists (
        select 1 from pg_attribute a where a.attrelid = p_table and a.attname = v_column and a.attnum > 0
          and not a.attisdropped) then
      raise exception '% has no column %', p_table, v_column using errcode = '23514';
    end if;
  end loop;
  execute format('grant usage on schema %I to portal_actor', v_schema);
  execute format(
    'create policy %I on %s for select to portal_actor using (workspace_id = (select portal.workspace()) '
    'and %I in (select portal.records()))',
    v_name || '_portal_select', p_table, p_record_column);
  execute format('grant select (%s) on %s to portal_actor',
    (select string_agg(format('%I', c), ', ') from unnest(v_columns) c), p_table);
end $$;
revoke execute on function private.addon_portal_policies(regclass, name, name[]) from public;
