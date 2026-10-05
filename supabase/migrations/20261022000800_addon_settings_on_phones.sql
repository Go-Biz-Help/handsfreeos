-- =============================================================================
-- An add-on's settings on phones (round six; core).
--
--        Some of a page's answers rest on how the business set an add-on up:
--        Real Estate counts business days around the days it's closed
--        (`closedDays`), and the phone's Coordinate works them out with no
--        signal. An add-on names the keys of its settings phones keep (its
--        manifest's `offline.settings`); a trigger copies just those keys
--        into one row of app.addon_phone_rows per business (source
--        '_settings', no record), open to whoever holds the add-on's key, so
--        records_v1 sends it with nothing new in the sync config. The rest of
--        its settings stay on the server.
-- =============================================================================

alter table app.addon_phone_addons add column settings_keys text[] not null default '{}';
comment on column app.addon_phone_addons.settings_keys is
  'Keys of the add-on''s business settings phones keep, copied into app.addon_phone_rows as its ''_settings'' row (round six).';

-- The business's '_settings' row for an add-on: its kept keys, or no row when it keeps none.
create or replace function private.addon_phone_settings_row(p_ws uuid, p_addon text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_keys text[];
  v_perm text;
  v_settings jsonb;
begin
  select a.settings_keys, a.permission into v_keys, v_perm from app.addon_phone_addons a where a.addon_id = p_addon;
  select i.settings into v_settings from app.addon_installations i
  where i.workspace_id = p_ws and i.addon_id = p_addon;
  if v_perm is null or coalesce(cardinality(v_keys), 0) = 0 or v_settings is null then
    delete from app.addon_phone_rows p where p.id = '_settings:' || p_addon || ':' || p_ws;
    return;
  end if;
  insert into app.addon_phone_rows as p (id, workspace_id, addon_id, source, record_id, data, reach,
    seal_scope, seal_open, seal_viewer_ids, seal_all, sync_window, updated_at)
  values ('_settings:' || p_addon || ':' || p_ws, p_ws, p_addon, '_settings', null,
    (select coalesce(jsonb_object_agg(k, v_settings -> k), '{}'::jsonb) from unnest(v_keys) k where v_settings ? k),
    'team', p_ws::text || ':' || v_perm, true, '{}', null, true, now())
  on conflict (id) do update set data = excluded.data, seal_scope = excluded.seal_scope, updated_at = excluded.updated_at
  where p.data is distinct from excluded.data or p.seal_scope is distinct from excluded.seal_scope;
end $$;

create or replace function private.addon_phone_settings_copy()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from app.addon_phone_rows p where p.id = '_settings:' || old.addon_id || ':' || old.workspace_id;
    return null;
  end if;
  perform private.addon_phone_settings_row(new.workspace_id, new.addon_id);
  return null;
end $$;

create trigger addon_installations_phone_settings
  after insert or update of settings or delete on app.addon_installations
  for each row execute function private.addon_phone_settings_copy();

-- Names the settings keys an add-on's phones keep, and copies them for every business that has it. Migrations call it.
create or replace function private.addon_phone_settings(p_addon text, p_keys text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
begin
  if not exists (select 1 from app.addon_phone_addons a where a.addon_id = p_addon) then
    raise exception 'Name the add-on first with private.addon_phone_addon()' using errcode = '23514';
  end if;
  foreach v_key in array coalesce(p_keys, '{}') loop
    if v_key !~ '^[A-Za-z][A-Za-z0-9_]{0,62}$' then
      raise exception '% isn''t a settings key', v_key using errcode = '23514';
    end if;
    if v_key ~* '(secret|token|password|api_?key|private_?key|credential)' then
      raise exception '% looks like a secret, which phones never keep', v_key using errcode = '23514';
    end if;
  end loop;
  update app.addon_phone_addons set settings_keys = coalesce(p_keys, '{}') where addon_id = p_addon;
  perform private.addon_phone_settings_row(i.workspace_id, p_addon)
  from app.addon_installations i where i.addon_id = p_addon;
end $$;
revoke all on function private.addon_phone_settings(text, text[]) from public;

-- The phone-rows check, with settings: 20261022000100's, renamed, and the '_settings' rows beside it.
alter function private.addon_phone_mismatches(uuid) rename to addon_phone_table_mismatches;

create or replace function private.addon_phone_mismatches(p_ws uuid default null)
returns table (id text, problem text) language sql stable security definer set search_path = '' as $$
  select m.id, m.problem from private.addon_phone_table_mismatches(p_ws) m
  where not (m.problem = 'not a table phones keep' and m.id like '\_settings:%')
  union all
  select '_settings:' || a.addon_id || ':' || i.workspace_id, 'missing or stale'
  from app.addon_installations i
  join app.addon_phone_addons a on a.addon_id = i.addon_id and cardinality(a.settings_keys) > 0
  where (p_ws is null or i.workspace_id = p_ws)
    and not exists (
      select 1 from app.addon_phone_rows p
      where p.id = '_settings:' || a.addon_id || ':' || i.workspace_id
        and p.seal_scope = i.workspace_id::text || ':' || a.permission and p.seal_open and p.record_id is null
        and p.data = (select coalesce(jsonb_object_agg(k, i.settings -> k), '{}'::jsonb)
                      from unnest(a.settings_keys) k where i.settings ? k))
  union all
  select p.id, 'left over' from app.addon_phone_rows p
  where p.source = '_settings' and (p_ws is null or p.workspace_id = p_ws)
    and not exists (
      select 1 from app.addon_installations i join app.addon_phone_addons a on a.addon_id = i.addon_id
      where p.id = '_settings:' || a.addon_id || ':' || i.workspace_id and cardinality(a.settings_keys) > 0)
$$;

grant execute on function private.addon_phone_mismatches(uuid) to service_actor;
