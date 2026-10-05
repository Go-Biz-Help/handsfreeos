-- =============================================================================
-- Who's on the team reaches the phones of whoever sees every record (round
-- six; core).
--
--        Chris decided (2026-10-03) that phones get the team's permissions, so
--        a coordinator's Team workload works with no signal. Workload lists
--        everyone who holds an add-on's permission, with their role, and only
--        someone who sees every record of its kind may read it.
--
--        app.sync_keys already holds, per person, a `use` key for each add-on
--        they hold and an `all` key for each kind they see every record of.
--        Each key now says its add-on and the person's role, and a
--        `team_scope` ('<business>:<add-on>') a stream can compare: someone
--        holding an `all` key may read the `use` keys of the same add-on in
--        the same business (their teammates' and their own), and records_v1
--        sends them. Nothing more about anyone's permissions leaves.
-- =============================================================================

alter table app.sync_keys
  add column addon_id text,
  add column role text,
  add column team_scope text;
comment on column app.sync_keys.team_scope is
  '''<business>:<add-on>'': who holds this add-on''s `all` key here may read its `use` keys (round six). Kept with the key.';
create index sync_keys_team_idx on app.sync_keys (team_scope) where kind = 'use';

-- What a person's keys should be in one business: 20261022000100's, with the add-on and their role.
drop function private.sync_keys_wanted(uuid, uuid) cascade;
create function private.sync_keys_wanted(p_user uuid, p_ws uuid)
returns table (kind text, key text, addon_id text, role text) language sql stable security definer set search_path = '' as $$
  select 'use', p_ws::text || ':' || a.permission, a.addon_id, wa.role::text
  from app.workspace_access wa, app.addon_phone_addons a
  where wa.user_id = p_user and wa.workspace_id = p_ws and a.permission = any (wa.permissions)
  union
  select 'all', p_ws::text || ':' || t.see_all_permission, t.addon_id, wa.role::text
  from app.workspace_access wa
  join app.custom_record_types t on t.workspace_id = wa.workspace_id
  where wa.user_id = p_user and wa.workspace_id = p_ws
    and t.kept_to_team and t.see_all_permission = any (wa.permissions)
    and t.addon_id in (select a.addon_id from app.addon_phone_addons a)
$$;

create or replace function private.sync_keys_refresh(p_user uuid, p_ws uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from app.sync_keys k
  where k.user_id = p_user and k.workspace_id = p_ws
    and (k.kind, k.key) not in (select w.kind, w.key from private.sync_keys_wanted(p_user, p_ws) w);
  insert into app.sync_keys as k (user_id, workspace_id, kind, key, addon_id, role, team_scope)
  select p_user, p_ws, w.kind, w.key, w.addon_id, w.role, p_ws::text || ':' || w.addon_id
  from private.sync_keys_wanted(p_user, p_ws) w
  on conflict (user_id, workspace_id, kind, key) do update
    set addon_id = excluded.addon_id, role = excluded.role, team_scope = excluded.team_scope
    where k.addon_id is distinct from excluded.addon_id or k.role is distinct from excluded.role
       or k.team_scope is distinct from excluded.team_scope;
end $$;

-- A role changing moves the keys' role too.
drop trigger workspace_access_sync_keys on app.workspace_access;
create trigger workspace_access_sync_keys
  after insert or delete or update of permissions, role on app.workspace_access
  for each row execute function private.sync_keys_follow_access();

-- The add-ons a person sees every record of, in each business: '<business>:<add-on>'.
create or replace function private.my_team_scopes()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct k.team_scope), '{}') from app.sync_keys k
  where k.user_id = (select auth.uid()) and k.kind = 'all'
$$;
revoke all on function private.my_team_scopes() from public;
grant execute on function private.my_team_scopes() to authenticated;

create policy sync_keys_team on app.sync_keys for select to authenticated
  using (kind = 'use' and team_scope = any (private.my_team_scopes()));

-- 20261022000100's check, with the add-on, role and scope.
create or replace function private.sync_key_mismatches(p_ws uuid default null)
returns table (user_id uuid, workspace_id uuid, kind text, key text, problem text)
language sql stable security definer set search_path = '' as $$
  with wanted as (
    select wa.user_id, wa.workspace_id, w.kind, w.key, w.addon_id, w.role
    from app.workspace_access wa, private.sync_keys_wanted(wa.user_id, wa.workspace_id) w
    where p_ws is null or wa.workspace_id = p_ws
  )
  select w.user_id, w.workspace_id, w.kind, w.key, 'missing' from wanted w
  where not exists (select 1 from app.sync_keys k where (k.user_id, k.workspace_id, k.kind, k.key)
                    = (w.user_id, w.workspace_id, w.kind, w.key))
  union all
  select w.user_id, w.workspace_id, w.kind, w.key, 'stale' from wanted w
  join app.sync_keys k on (k.user_id, k.workspace_id, k.kind, k.key) = (w.user_id, w.workspace_id, w.kind, w.key)
  where k.addon_id is distinct from w.addon_id or k.role is distinct from w.role
     or k.team_scope is distinct from (w.workspace_id::text || ':' || w.addon_id)
  union all
  select k.user_id, k.workspace_id, k.kind, k.key, 'extra' from app.sync_keys k
  where (p_ws is null or k.workspace_id = p_ws)
    and not exists (select 1 from wanted w where (k.user_id, k.workspace_id, k.kind, k.key)
                    = (w.user_id, w.workspace_id, w.kind, w.key))
$$;

-- What's there now.
select private.sync_keys_refresh_workspace(null);
