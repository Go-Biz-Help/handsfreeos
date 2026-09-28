-- =============================================================================
-- Removing an add-on cleanly, and proving it.
--
--        Every move an add-on makes ends with a check that nothing is left
--        where it shouldn't be (private.addon_verify): an add-on that is off
--        has no permissions in anyone's list, no queued jobs or provider
--        messages waiting, and no kinds of records showing; one that is
--        uninstalled holds nothing outside HandsFreeOS either; and one whose
--        data was permanently deleted has no rows left in its schema, its
--        records reduced to their names, and its details gone from history.
--        The worker stores the answer on the installation and never reports a
--        move done while a check fails.
--
--        **Permanently deleting an add-on's data** (private.purge_addon_batch)
--        runs in batches, from the worker, only for an add-on already
--        uninstalled and marked `purging`. It deletes the rows in the add-on's
--        own schema and the relationship pairs and types it managed; keeps
--        each of its records as a named tombstone, so the tasks, files and
--        timeline lines that pointed at one still say what it was; clears
--        its settings and the business's permission choices for it; and,
--        as the owner decided (2026-09-28), keeps the history lines while
--        dropping the add-on's details: its events keep what happened, who
--        and when, and lose their payload; its audit rows lose their before
--        and after. Core records — customers, conversations, invoices,
--        payments, files, tasks — are never deleted.
--
--        History is append-only (0003, 0096); the only way past that, as for
--        a whole business being deleted, is a marker that exists only inside
--        the purge's own transaction, now scoped to one add-on in one business
--        and to its own rows' detail columns.
-- =============================================================================

-- ---------- the purge's marker ----------
create table private.addon_purges (
  workspace_id uuid not null,
  addon_id text not null,
  primary key (workspace_id, addon_id)
);
revoke all on private.addon_purges from public;

-- True only inside private.purge_addon_batch's own transaction (the row is never committed).
create or replace function private.purging_addon(p_workspace uuid, p_addon text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.addon_purges p where p.workspace_id = p_workspace and p.addon_id = p_addon)
$$;
grant execute on function private.purging_addon(uuid, text) to public;

-- The event log and the audit log: append-only, except for the business being purged (0096) and, now, an add-on's
-- own rows while its data is being deleted, and then only their detail columns.
create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace((to_jsonb(old) ->> 'workspace_id')::uuid) then
    return old;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> 'addon_id') is not null
     and private.purging_addon((to_jsonb(old) ->> 'workspace_id')::uuid, to_jsonb(old) ->> 'addon_id')
     and (to_jsonb(new) - array['payload', 'before', 'after']) = (to_jsonb(old) - array['payload', 'before', 'after']) then
    return new;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '42501';
end $$;

-- ---------- nothing left behind ----------
-- The add-on's permissions (from its declared rows), for the checks below.
create or replace function private.addon_permissions(p_addon text)
returns setof text language sql stable security definer set search_path = '' as $$
  select rp.permission from app.role_permissions rp where rp.addon_id = p_addon
  union
  select c.permission from app.customizable_permissions c where c.addon_id = p_addon
$$;

-- Rows the add-on still keeps for one business in its own schema.
create or replace function private.addon_owned_rows(p_ws uuid, p_addon text)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare
  v_table regclass;
  v_n bigint;
  v_total bigint := 0;
begin
  for v_table in
    select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'addon_' || p_addon and c.relkind in ('r', 'p')
  loop
    execute format('select count(*) from %s where workspace_id = $1', v_table) into v_n using p_ws;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end $$;

-- Every check for one add-on in one business, for the state it is in now. `found` is how many things are where
-- they shouldn't be; ok means none.
create or replace function private.addon_verify(p_ws uuid, p_addon text)
returns table (check_name text, ok boolean, found bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_state text;
  v_n bigint;
begin
  select i.state into v_state from app.addon_installations i where i.workspace_id = p_ws and i.addon_id = p_addon;
  if v_state is null then
    return;
  end if;
  if v_state = 'enabled' then
    select count(*) into v_n from app.custom_record_types t
    where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is not null;
    return query select 'record_kinds_shown'::text, v_n = 0, v_n;
    return;
  end if;
  -- Off, arriving, leaving or gone: it runs nowhere here.
  select count(*) into v_n from app.workspace_access wa
  where wa.workspace_id = p_ws
    and wa.permissions && array(select private.addon_permissions(p_addon));
  return query select 'no_permissions_held'::text, v_n = 0, v_n;
  select count(*) into v_n from app.scheduled_jobs j
  where j.workspace_id = p_ws and j.addon_id = p_addon and j.status = 'pending';
  return query select 'no_jobs_pending'::text, v_n = 0, v_n;
  select count(*) into v_n from app.webhook_deliveries d
  where d.workspace_id = p_ws and d.addon_id = p_addon and d.status = 'pending';
  return query select 'no_deliveries_pending'::text, v_n = 0, v_n;
  select count(*) into v_n from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is null;
  return query select 'record_kinds_hidden'::text, v_n = 0, v_n;
  select count(*) into v_n from app.relationship_types r
  where r.workspace_id = p_ws and r.addon_id = p_addon and r.archived_at is null;
  return query select 'relationship_types_hidden'::text, v_n = 0, v_n;
  if v_state in ('uninstalled', 'purging', 'purged') then
    select count(*) into v_n from app.addon_resources r
    where r.workspace_id = p_ws and r.addon_id = p_addon and r.status <> 'released';
    return query select 'no_resources_held'::text, v_n = 0, v_n;
  end if;
  if v_state = 'purged' then
    v_n := private.addon_owned_rows(p_ws, p_addon);
    return query select 'no_rows_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    where r.workspace_id = p_ws and t.addon_id = p_addon and r.purged_at is null;
    return query select 'records_tombstoned'::text, v_n = 0, v_n;
    select count(*) into v_n from app.relationships r
    join app.relationship_types t on t.id = r.type_id
    where r.workspace_id = p_ws and t.addon_id = p_addon;
    return query select 'no_relationships_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon and (i.settings <> '{}'::jsonb or i.flags <> '{}'::jsonb);
    select v_n + count(*) into v_n from app.addon_user_settings s where s.workspace_id = p_ws and s.addon_id = p_addon;
    return query select 'no_settings_left'::text, v_n = 0, v_n;
    select count(*) into v_n from (
      select 1 from app.role_permission_overrides o
      where o.workspace_id = p_ws and o.permission in (select private.addon_permissions(p_addon))
      union all
      select 1 from app.member_permission_overrides o
      where o.workspace_id = p_ws and o.permission in (select private.addon_permissions(p_addon))) x;
    return query select 'no_permission_choices_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.events e
    where e.workspace_id = p_ws and e.addon_id = p_addon and not (e.payload ? '_redacted');
    select v_n + count(*) into v_n from app.audit_logs a
    where a.workspace_id = p_ws and a.addon_id = p_addon and (a.before is not null or a.after is not null);
    return query select 'history_details_removed'::text, v_n = 0, v_n;
  end if;
end $$;

-- ---------- permanently deleting an add-on's data ----------
-- One batch of the purge, for the worker, in the business it is scoped to. Returns true while there is more to do;
-- the last batch marks the add-on purged. Each step is idempotent, so a batch that fails is simply run again.
create or replace function private.purge_addon_batch(p_ws uuid, p_addon text, p_limit integer default 5000)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_table regclass;
  v_n integer;
  v_kinds uuid[];
  v_types uuid[];
  v_permissions text[];
begin
  if p_ws is distinct from private.system_scope_workspace() then
    raise exception 'The purge runs in the worker, scoped to the business' using errcode = '42501';
  end if;
  perform 1 from app.addon_installations i
  where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'purging'
  for update;
  if not found then
    raise exception 'That add-on''s data isn''t being deleted here' using errcode = '55000', detail = 'addon_not_purging';
  end if;
  insert into private.addon_purges (workspace_id, addon_id) values (p_ws, p_addon) on conflict do nothing;

  -- 1. Its own tables, a batch at a time. Its foreign keys between its own tables cascade (the catalogue test),
  --    so the order doesn't matter.
  for v_table in
    select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'addon_' || p_addon and c.relkind = 'r'
    order by c.relname
  loop
    execute format('delete from %s where ctid in (select ctid from %s where workspace_id = $1 limit $2)',
      v_table, v_table) using p_ws, p_limit;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
      return true;
    end if;
  end loop;

  -- 2. The relationships it managed, then the types themselves.
  select coalesce(array_agg(t.id), '{}') into v_types from app.relationship_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon;
  delete from app.relationships r
  where r.id in (select x.id from app.relationships x where x.workspace_id = p_ws and x.type_id = any (v_types)
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  delete from app.relationship_types t where t.id = any (v_types);

  -- 3. Its records reduced to their names: what pointed at one still reads, and nothing else about it is kept.
  select coalesce(array_agg(t.id), '{}') into v_kinds from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon;
  update app.custom_records r set purged_at = now(), archived_at = coalesce(r.archived_at, now()),
    notes = null, custom = '{}'::jsonb, field_times = '{}'::jsonb
  where r.id in (select x.id from app.custom_records x
                 where x.workspace_id = p_ws and x.type_id = any (v_kinds) and x.purged_at is null
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 4. History keeps its lines and loses the add-on's details (the owner's decision, 2026-09-28).
  update app.events e set payload = jsonb_build_object('_addon', e.payload -> '_addon', '_redacted', true)
  where e.id in (select x.id from app.events x
                 where x.workspace_id = p_ws and x.addon_id = p_addon and not (x.payload ? '_redacted')
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  update app.audit_logs a set before = null, after = null
  where a.id in (select x.id from app.audit_logs x
                 where x.workspace_id = p_ws and x.addon_id = p_addon and (x.before is not null or x.after is not null)
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 5. Its settings, and the business's own choices about its permissions.
  select coalesce(array_agg(p), '{}') into v_permissions from private.addon_permissions(p_addon) p;
  delete from app.role_permission_overrides o where o.workspace_id = p_ws and o.permission = any (v_permissions);
  delete from app.member_permission_overrides o where o.workspace_id = p_ws and o.permission = any (v_permissions);
  delete from app.addon_user_settings s where s.workspace_id = p_ws and s.addon_id = p_addon;
  update app.addon_installations i set settings = '{}'::jsonb, flags = '{}'::jsonb, state = 'purged',
    last_error = null
  where i.workspace_id = p_ws and i.addon_id = p_addon;
  delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
  return false;
end $$;

revoke all on function private.addon_permissions(text), private.addon_owned_rows(uuid, text),
  private.addon_verify(uuid, text), private.purge_addon_batch(uuid, text, integer) from public;
grant execute on function private.addon_verify(uuid, text), private.purge_addon_batch(uuid, text, integer)
  to service_actor;
