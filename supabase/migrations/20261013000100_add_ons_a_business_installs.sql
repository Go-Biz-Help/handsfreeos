-- =============================================================================
-- Add-ons a business installs, and where each one stands.
--
--        An add-on is first-party code that ships with every deploy and is
--        switched on per business (docs/addon-architecture.md). What an add-on
--        is lives in code (packages/core/src/addons): its manifest, the one
--        list every layer reads. The database keeps each business's choice,
--        and the rules that make the choice hold whoever writes:
--
--        - **app.addon_installations**: one row per business and add-on it
--          ever installed. Its state (installing, enabled, disabled,
--          uninstalling, uninstalled, purging, purged); the code version and
--          the shape its data and settings are at; its settings and switches;
--          and a generation that goes up on every reinstall, so work queued
--          before it can tell it is stale. Only `enabled` runs.
--        - **app.addon_user_settings**: each person's own settings for one.
--        - **platform.addon_overrides**: HandsFreeOS switching an add-on off
--          (or marking it deprecated) everywhere at once, whatever the code
--          says. Only ever downwards.
--
--        A person moves an add-on only through private.addon_move(), which
--        checks the move, the permission (addons.manage; addons.purge, which
--        only owners hold, to delete data) and the generation in one place.
--        The worker finishes the moves that take time; the guard below lets
--        it make only those. No row means the business never had it — every
--        business today — so the code already running reads what it did.
--
--        **An add-on's permissions exist only while it runs.** They are
--        declared per add-on (role_permissions and customizable_permissions
--        gain `addon_id`), and private.user_permissions() leaves out those of
--        an add-on that isn't enabled in the business. The stored answer in
--        app.workspace_access (0106) is what row security, the kernel, the
--        screens, the phone and the Assistant all read, so turning an add-on
--        off takes it away from people everywhere at once, at no cost per row.
--        Changing an add-on's state refreshes only that business's people;
--        declaring an add-on's permissions refreshes only the businesses where
--        it runs; core's defaults still refresh everyone (PERF, P-4).
--
--        And the money and inbox repaints (0083, 0106) now fire only when a
--        permission they read moves, not on every change to someone's list,
--        so twenty add-ons coming and going never repaint a single bill.
-- =============================================================================

-- ---------- where each add-on stands in each business ----------
create table app.addon_installations (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The add-on's id in core's catalogue ('pm'). Never reused.
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  state text not null check (state in (
    'installing', 'enabled', 'disabled', 'uninstalling', 'uninstalled', 'purging', 'purged')),
  -- The code version installed, and the shape the business's data and settings for it are at. The worker brings
  -- data and settings up to the code's when it (re)installs.
  installed_version text not null check (length(installed_version) between 1 and 40),
  data_version integer not null default 1 check (data_version >= 0),
  settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 65536),
  settings_version integer not null default 1 check (settings_version >= 1),
  flags jsonb not null default '{}'::jsonb
    check (jsonb_typeof(flags) = 'object' and pg_column_size(flags) <= 8192),
  -- One more on every reinstall: work queued for an earlier generation never runs.
  generation integer not null default 1 check (generation >= 1),
  installed_by uuid references app.users (id) on delete set null,
  installed_at timestamptz not null default now(),
  changed_by uuid references app.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  -- What the worker found the last time it checked nothing was left behind, and any trouble finishing a move.
  verification jsonb,
  verified_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, addon_id)
);
-- The businesses an add-on runs in: sweeps and planners walk only these.
create index addon_installations_enabled_idx on app.addon_installations (addon_id, workspace_id)
  where state = 'enabled';
create index addon_installations_installed_by_idx on app.addon_installations (installed_by);
create index addon_installations_changed_by_idx on app.addon_installations (changed_by);
create trigger addon_installations_updated_at before update on app.addon_installations
  for each row execute function private.set_updated_at();
create trigger addon_installations_immutable before update on app.addon_installations
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'addon_id');

-- The moves, as packages/core/src/addons/lifecycle.ts has them. `via` says who asks: a person, or the worker, which
-- also finishes the three moves that take time.
create or replace function private.addon_move_allowed(p_from text, p_to text, p_worker boolean)
returns boolean language sql immutable set search_path = '' as $$
  select (p_from, p_to) in (
      ('uninstalled', 'installing'), ('purged', 'installing'),
      ('disabled', 'enabled'),
      ('enabled', 'disabled'), ('installing', 'disabled'),
      ('installing', 'uninstalling'), ('enabled', 'uninstalling'), ('disabled', 'uninstalling'),
      ('uninstalled', 'purging'))
    or (p_worker and (p_from, p_to) in (
      ('installing', 'enabled'), ('uninstalling', 'uninstalled'), ('purging', 'purged')))
$$;

-- Whoever writes a row directly (the worker; a person only ever reads) is held to the moves. Not security definer:
-- it asks who is writing.
create or replace function private.guard_addon_installation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'service_actor') then
    return new;
  end if;
  if current_user = 'authenticated' then
    raise exception 'Add-ons are installed and removed through their commands'
      using errcode = '42501', detail = 'addon_installation_is_ours';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'installing' or new.generation <> 1 then
      raise exception 'An add-on starts out installing, at generation 1'
        using errcode = '23514', detail = 'addon_bad_start';
    end if;
    return new;
  end if;
  if new.state is distinct from old.state
     and not private.addon_move_allowed(old.state, new.state, true) then
    raise exception 'An add-on can''t go from % to %', old.state, new.state
      using errcode = '23514', detail = 'addon_bad_move';
  end if;
  if new.generation <> old.generation
     and not (new.state = 'installing' and old.state in ('uninstalled', 'purged')
              and new.generation = old.generation + 1) then
    raise exception 'The generation only moves on, by one, when an add-on is installed again'
      using errcode = '23514', detail = 'addon_bad_generation';
  end if;
  return new;
end $$;
create trigger addon_installations_guard before insert or update on app.addon_installations
  for each row execute function private.guard_addon_installation();

alter table app.addon_installations enable row level security;
-- Everyone who works in the business sees what it has: the menu, the screens and the Assistant read it.
create policy addon_installations_select on app.addon_installations for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy addon_installations_service_all on app.addon_installations for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.addon_installations to authenticated;
grant select, insert, update, delete on app.addon_installations to service_actor;
revoke all on app.addon_installations from anon;

-- ---------- HandsFreeOS switching an add-on off everywhere ----------
create table platform.addon_overrides (
  addon_id text primary key check (addon_id ~ '^[a-z]{2,16}$'),
  -- Only ever downwards: deprecated (runs where installed, never offered) or unavailable (runs nowhere).
  status text not null check (status in ('deprecated', 'unavailable')),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  set_by uuid references app.users (id) on delete set null,
  set_at timestamptz not null default now()
);
create index addon_overrides_set_by_idx on platform.addon_overrides (set_by);
alter table platform.addon_overrides enable row level security;
-- Anyone signed in may read it: the screens and the Assistant need to know an add-on is off everywhere.
create policy addon_overrides_select on platform.addon_overrides for select to authenticated using (true);
create policy addon_overrides_service_select on platform.addon_overrides for select to service_actor using (true);
grant select on platform.addon_overrides to authenticated, service_actor;
revoke all on platform.addon_overrides from anon;

-- The staff permission to set one, beside the other platform permissions (packages/core/src/permissions.ts).
insert into app.role_permissions (role, permission) values ('staff_admin', 'platform.addons.manage');

-- ---------- whether an add-on runs, the one question every checkpoint asks ----------
-- The add-ons running in a business: enabled there, and not switched off by HandsFreeOS. Only the business's own
-- people and its own worker scope get an answer.
create or replace function private.active_addons(p_ws uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.addon_id order by i.addon_id), '{}'::text[])
  from app.addon_installations i
  where i.workspace_id = p_ws and i.state = 'enabled'
    and not exists (
      select 1 from platform.addon_overrides o where o.addon_id = i.addon_id and o.status = 'unavailable')
$$;

-- Whether one add-on runs here, for the kernel. With p_lock it also holds a key-share lock on the business's row
-- until the transaction ends, so an add-on command that started before a disable finishes before the disable
-- does (private.addon_move takes the row for update), and nothing starts after it: no half-off moment.
create or replace function private.addon_in_use(p_ws uuid, p_addon text, p_lock boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_state text;
begin
  if p_ws is null or p_addon is null then
    return false;
  end if;
  -- Only for the business the asker is in: a person who works there, or the worker scoped to it.
  if p_ws is distinct from private.system_scope_workspace()
     and not exists (select 1 from private.accessible_workspace_ids() a(id) where a.id = p_ws) then
    return false;
  end if;
  if p_lock then
    select i.state into v_state from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon
    for key share;
  else
    select i.state into v_state from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon;
  end if;
  return v_state = 'enabled'
    and not exists (select 1 from platform.addon_overrides o where o.addon_id = p_addon and o.status = 'unavailable');
end $$;

revoke all on function private.active_addons(uuid), private.addon_in_use(uuid, text, boolean) from public;
grant execute on function private.active_addons(uuid), private.addon_in_use(uuid, text, boolean)
  to authenticated, service_actor;

-- ---------- each person's own settings for an add-on ----------
create table app.addon_user_settings (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 16384),
  settings_version integer not null default 1 check (settings_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id, addon_id)
);
create index addon_user_settings_user_idx on app.addon_user_settings (user_id);
create index addon_user_settings_addon_idx on app.addon_user_settings (workspace_id, addon_id);
create trigger addon_user_settings_updated_at before update on app.addon_user_settings
  for each row execute function private.set_updated_at();
create trigger addon_user_settings_immutable before update on app.addon_user_settings
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'addon_id');

alter table app.addon_user_settings enable row level security;
-- A person's own, and only while the add-on runs: its settings are part of it.
create policy addon_user_settings_select on app.addon_user_settings for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy addon_user_settings_insert on app.addon_user_settings for insert to authenticated
  with check (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids())
    and private.addon_in_use(workspace_id, addon_id, false));
create policy addon_user_settings_update on app.addon_user_settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.addon_in_use(workspace_id, addon_id, false));
create policy addon_user_settings_service_all on app.addon_user_settings for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert on app.addon_user_settings to authenticated;
grant update (settings, settings_version, updated_at) on app.addon_user_settings to authenticated;
grant select, insert, update, delete on app.addon_user_settings to service_actor;
revoke all on app.addon_user_settings from anon;

-- ---------- a person's moves ----------
-- Every move a person makes on an add-on in one business, checked here whatever calls it: the move is allowed from
-- where it stands, they hold addons.manage (addons.purge to delete its data), and a reinstall starts a new
-- generation at the code version the command read from the catalogue. Returns the row as it now is. The commands
-- check the catalogue (status, dependencies) first; this is the part the database can check on its own.
create or replace function private.addon_move(
  p_ws uuid, p_addon text, p_to text, p_version text, p_data_version integer, p_settings_version integer)
returns table (state text, generation integer, previous_state text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_row app.addon_installations%rowtype;
  v_from text;
begin
  if v_user is null then
    raise exception 'Sign in to change add-ons' using errcode = '42501', detail = 'addon_needs_person';
  end if;
  if not private.has_permission(p_ws, case when p_to = 'purging' then 'addons.purge' else 'addons.manage' end) then
    raise exception 'You can''t change add-ons here' using errcode = '42501',
      detail = case when p_to = 'purging' then 'addon_purge_owner_only' else 'addon_needs_manage' end;
  end if;
  select * into v_row from app.addon_installations i
  where i.workspace_id = p_ws and i.addon_id = p_addon
  for update;
  v_from := v_row.state;
  if not found then
    if p_to <> 'installing' then
      raise exception 'That add-on isn''t installed here' using errcode = '23514', detail = 'addon_not_installed';
    end if;
    insert into app.addon_installations as i (workspace_id, addon_id, state, installed_version, data_version,
      settings_version, generation, installed_by, installed_at, changed_by, changed_at)
    values (p_ws, p_addon, 'installing', p_version, p_data_version, p_settings_version, 1, v_user, now(), v_user, now());
    return query select 'installing'::text, 1, null::text;
    return;
  end if;
  if v_from = p_to then
    return query select v_from, v_row.generation, v_from;
    return;
  end if;
  if not private.addon_move_allowed(v_from, p_to, false) then
    raise exception 'An add-on can''t go from % to %', v_from, p_to using errcode = '23514', detail = 'addon_bad_move';
  end if;
  if p_to = 'installing' then
    -- A reinstall: a new generation, at the code's version. What was kept (uninstalled) keeps the shape it was
    -- written in, for the worker to bring up to date; after a purge there is nothing left to migrate.
    update app.addon_installations i set
      state = 'installing', generation = i.generation + 1, installed_version = p_version,
      data_version = case when v_from = 'purged' then p_data_version else i.data_version end,
      settings_version = case when v_from = 'purged' then p_settings_version else i.settings_version end,
      installed_by = v_user, installed_at = now(), changed_by = v_user, changed_at = now(),
      last_error = null, verification = null, verified_at = null
    where i.workspace_id = p_ws and i.addon_id = p_addon;
  else
    update app.addon_installations i set state = p_to, changed_by = v_user, changed_at = now(), last_error = null
    where i.workspace_id = p_ws and i.addon_id = p_addon;
  end if;
  return query select i.state, i.generation, v_from from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon;
end $$;

-- A business's settings for an add-on that runs there, by someone who holds the add-on's settings permission (the
-- manifest's, else addons.manage). Only a permission of that add-on, or addons.manage, can be the one asked for.
create or replace function private.save_addon_settings(
  p_ws uuid, p_addon text, p_permission text, p_settings jsonb, p_settings_version integer, p_flags jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_permission <> 'addons.manage' and not exists (
      select 1 from app.role_permissions rp where rp.permission = p_permission and rp.addon_id = p_addon) then
    raise exception 'That isn''t a permission of this add-on' using errcode = '42501', detail = 'addon_bad_permission';
  end if;
  if not private.has_permission(p_ws, p_permission) then
    raise exception 'You can''t change this add-on''s settings' using errcode = '42501', detail = 'addon_settings_forbidden';
  end if;
  update app.addon_installations i set
    settings = coalesce(p_settings, i.settings),
    settings_version = coalesce(p_settings_version, i.settings_version),
    flags = coalesce(p_flags, i.flags),
    changed_by = auth.uid(), changed_at = now()
  where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'enabled';
  if not found then
    raise exception 'That add-on isn''t on here' using errcode = '23514', detail = 'addon_inactive';
  end if;
end $$;

-- HandsFreeOS switching an add-on off everywhere, or letting it back on (null status), with a reason. Staff with
-- platform.addons.manage only.
create or replace function private.set_addon_override(p_addon text, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'Only HandsFreeOS staff who manage add-ons can do that'
      using errcode = '42501', detail = 'addon_override_forbidden';
  end if;
  if p_status is null then
    delete from platform.addon_overrides where addon_id = p_addon;
  else
    insert into platform.addon_overrides (addon_id, status, reason, set_by, set_at)
    values (p_addon, p_status, p_reason, auth.uid(), now())
    on conflict (addon_id) do update set status = excluded.status, reason = excluded.reason,
      set_by = excluded.set_by, set_at = excluded.set_at;
  end if;
end $$;

revoke all on function private.addon_move(uuid, text, text, text, integer, integer),
  private.save_addon_settings(uuid, text, text, jsonb, integer, jsonb),
  private.set_addon_override(text, text, text), private.addon_move_allowed(text, text, boolean)
  from public;
grant execute on function private.addon_move(uuid, text, text, text, integer, integer),
  private.save_addon_settings(uuid, text, text, jsonb, integer, jsonb),
  private.set_addon_override(text, text, text) to authenticated;
grant execute on function private.addon_move_allowed(text, text, boolean) to authenticated, service_actor;

-- ---------- permissions that belong to an add-on ----------
alter table app.role_permissions
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$');
alter table app.customizable_permissions
  add column addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$');
create index role_permissions_addon_idx on app.role_permissions (addon_id) where addon_id is not null;
create index customizable_permissions_addon_idx on app.customizable_permissions (addon_id)
  where addon_id is not null;

-- Everything one person may do in one business (0106), now without the permissions of add-ons that don't run
-- there. The rest is 0106's rule, unchanged.
create or replace function private.user_permissions(p_user uuid, p_ws uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  with r as (select private.user_workspace_role(p_user, p_ws) as role),
  live as (select private.active_addons(p_ws) as ids),
  candidates as (
    select rp.permission from app.role_permissions rp, r, live
    where rp.role = r.role and (rp.addon_id is null or rp.addon_id = any (live.ids))
    union
    select c.permission from app.customizable_permissions c, live
    where c.addon_id is null or c.addon_id = any (live.ids)
  ),
  base as (
    select k.permission,
      case
        when r.role is null then false
        when r.role = 'owner' then exists (
          select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = k.permission)
        else coalesce(
          (select m.allowed from app.member_permission_overrides m
           where m.workspace_id = p_ws and m.user_id = p_user and m.permission = k.permission),
          (select o.allowed from app.role_permission_overrides o
           where o.workspace_id = p_ws and o.role::text = r.role and o.permission = k.permission),
          exists (select 1 from app.role_permissions rp where rp.role = r.role and rp.permission = k.permission))
      end as allowed
    from candidates k cross join r
  )
  select coalesce(array_agg(b.permission order by b.permission), '{}'::text[])
  from base b
  where b.allowed
    and not exists (
      select 1 from app.customizable_permissions c
      cross join lateral unnest(c.requires) as q(p)
      where c.permission = b.permission
        and not exists (select 1 from base b2 where b2.permission = q.p and b2.allowed))
$$;

-- An add-on's permissions, as its migration declares them from its manifest: the owner and the roles it names get
-- each by default, and the ones a business may set are customizable, with what each requires. Idempotent, so a
-- later migration can call it again with the same list.
create or replace function private.register_addon_permissions(p_addon text, p_permissions jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_p jsonb;
begin
  for v_p in select value from jsonb_array_elements(p_permissions) loop
    if not (v_p ->> 'key') like p_addon || '.%' then
      raise exception 'Permission % must start with %.', v_p ->> 'key', p_addon using errcode = '23514';
    end if;
    insert into app.role_permissions (role, permission, addon_id)
    select r, v_p ->> 'key', p_addon
    from unnest(array['owner'] || array(select jsonb_array_elements_text(coalesce(v_p -> 'defaultRoles', '[]'::jsonb)))) r
    on conflict (role, permission) do nothing;
    if coalesce((v_p ->> 'customizable')::boolean, true) then
      insert into app.customizable_permissions (permission, requires, addon_id)
      values (v_p ->> 'key',
        array(select jsonb_array_elements_text(coalesce(v_p -> 'requires', '[]'::jsonb))), p_addon)
      on conflict (permission) do update set requires = excluded.requires, addon_id = excluded.addon_id;
    end if;
  end loop;
end $$;
revoke all on function private.register_addon_permissions(text, jsonb) from public;

-- An add-on starting or stopping in a business: its people's lists, and only theirs, and only when the add-on has
-- permissions at all.
create or replace function private.addon_state_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and new.state = 'enabled')
     or (tg_op = 'UPDATE' and (old.state = 'enabled') is distinct from (new.state = 'enabled')) then
    if exists (select 1 from app.role_permissions rp where rp.addon_id = new.addon_id)
       or exists (select 1 from app.customizable_permissions c where c.addon_id = new.addon_id) then
      perform private.refresh_workspace_access(wa.user_id, wa.workspace_id)
      from app.workspace_access wa where wa.workspace_id = new.workspace_id;
    end if;
  end if;
  return null;
end $$;
create trigger addon_installations_access after insert or update of state on app.addon_installations
  for each row execute function private.addon_state_changed();

-- HandsFreeOS switching an add-on off or back on: everyone in every business where it's enabled.
create or replace function private.addon_override_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_addon text := coalesce(new.addon_id, old.addon_id);
begin
  perform private.refresh_workspace_access(wa.user_id, wa.workspace_id)
  from app.workspace_access wa
  where wa.workspace_id in (
    select i.workspace_id from app.addon_installations i where i.addon_id = v_addon and i.state = 'enabled');
  return null;
end $$;
create trigger addon_overrides_access after insert or update or delete on platform.addon_overrides
  for each row execute function private.addon_override_changed();

-- The defaults changed. Core's rows (no add-on) still refresh everyone, everywhere, as 0106 did; an add-on's rows
-- refresh only the businesses where that add-on runs, which for a new add-on is none at all.
create or replace function private.permission_defaults_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_core boolean := false;
  v_addons text[];
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select coalesce(bool_or(n.addon_id is null), false), array_agg(distinct n.addon_id) filter (where n.addon_id is not null)
    into v_core, v_addons from new_rows n;
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    select v_core or coalesce(bool_or(o.addon_id is null), false),
      coalesce(v_addons, '{}'::text[]) || coalesce(array_agg(distinct o.addon_id) filter (where o.addon_id is not null), '{}'::text[])
    into v_core, v_addons from old_rows o;
  end if;
  if v_core then
    perform private.refresh_workspace_access(wa.user_id, wa.workspace_id) from app.workspace_access wa;
  elsif coalesce(cardinality(v_addons), 0) > 0 then
    perform private.refresh_workspace_access(wa.user_id, wa.workspace_id)
    from app.workspace_access wa
    where wa.workspace_id in (
      select i.workspace_id from app.addon_installations i where i.addon_id = any (v_addons) and i.state = 'enabled');
  end if;
  return null;
end $$;

drop trigger role_permissions_access on app.role_permissions;
drop trigger customizable_permissions_access on app.customizable_permissions;
create trigger role_permissions_access_insert after insert on app.role_permissions
  referencing new table as new_rows for each statement execute function private.permission_defaults_changed();
create trigger role_permissions_access_update after update on app.role_permissions
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.permission_defaults_changed();
create trigger role_permissions_access_delete after delete on app.role_permissions
  referencing old table as old_rows for each statement execute function private.permission_defaults_changed();
create trigger customizable_permissions_access_insert after insert on app.customizable_permissions
  referencing new table as new_rows for each statement execute function private.permission_defaults_changed();
create trigger customizable_permissions_access_update after update on app.customizable_permissions
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.permission_defaults_changed();
create trigger customizable_permissions_access_delete after delete on app.customizable_permissions
  referencing old table as old_rows for each statement execute function private.permission_defaults_changed();

-- ---------- the money and inbox repaints, only when what they read moves (P-4) ----------
-- Who sees a bill as a member reads money.read and money.manage (private.money_member_viewers); who sees a thread
-- reads inbox.use and channels.manage (private.inbox_eligible_members). Any other permission coming or going —
-- an add-on's, most of all — changes neither.
drop trigger workspace_access_money_viewers_changed on app.workspace_access;
create trigger workspace_access_money_viewers_changed after update on app.workspace_access for each row
  when (old.role is distinct from new.role
    or ('money.read' = any (old.permissions)) is distinct from ('money.read' = any (new.permissions))
    or ('money.manage' = any (old.permissions)) is distinct from ('money.manage' = any (new.permissions)))
  execute function private.money_viewers_access_changed();
drop trigger workspace_access_inbox_viewers_changed on app.workspace_access;
create constraint trigger workspace_access_inbox_viewers_changed after update on app.workspace_access
  deferrable initially deferred
  for each row
  when (old.role is distinct from new.role
    or ('inbox.use' = any (old.permissions)) is distinct from ('inbox.use' = any (new.permissions))
    or ('channels.manage' = any (old.permissions)) is distinct from ('channels.manage' = any (new.permissions)))
  execute function private.inbox_viewers_access_changed();

-- ---------- the permissions to manage add-ons ----------
-- Owners and admins install, turn off and uninstall add-ons, and a business may change that per role or person;
-- only owners permanently delete an add-on's data, and that is never handed out (the owner's decision, 2026-09-28).
insert into app.role_permissions (role, permission) values
  ('owner', 'addons.manage'), ('admin', 'addons.manage'), ('owner', 'addons.purge');
insert into app.customizable_permissions (permission, requires) values ('addons.manage', '{}');
