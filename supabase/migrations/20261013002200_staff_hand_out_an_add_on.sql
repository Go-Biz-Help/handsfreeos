-- =============================================================================
-- Staff hand an unfinished add-on to one business (Real Estate, step 2).
--
--        An add-on is offered to a business only once it is `available`. One
--        still being built (`development`, `beta`, `built`) was offered to
--        nobody, and nothing let staff hand it to a business to try, so the
--        first real add-on couldn't be tested anywhere but a laptop. Chris
--        decided (2026-09-30) that Real Estate stays hidden while it's built
--        and that staff turn it on for test businesses.
--
--        **A grant, not an install.** A row here says HandsFreeOS lets this
--        business install this add-on. Its owners and admins then add it
--        from their own Add-ons page, as they would an available one, so the
--        business still decides, and every move still goes through
--        `addon.install`. Core's catalogue rules read the grant
--        (`installableHere`); the database needs no other change.
--
--        **Taking it back stops new installs only.** An add-on the business
--        already added keeps running; it leaves the way any add-on does.
--
--        Staff with `platform.addons.manage` write grants, through
--        private.give_addon_grant and private.take_back_addon_grant, which
--        check the permission themselves. Staff who read businesses see them,
--        and a business's own people see theirs, which is how its Add-ons
--        page knows to offer the add-on.
-- =============================================================================

create table platform.addon_grants (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  note text check (note is null or length(note) <= 300),
  granted_by uuid references app.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (workspace_id, addon_id)
);
create index addon_grants_addon_idx on platform.addon_grants (addon_id);
create index addon_grants_granted_by_idx on platform.addon_grants (granted_by);

comment on table platform.addon_grants is
  'An add-on still being built that HandsFreeOS lets one business install to try it. Written by staff with platform.addons.manage.';

alter table platform.addon_grants enable row level security;
create policy addon_grants_select on platform.addon_grants for select to authenticated
  using (
    workspace_id in (select private.accessible_workspace_ids())
    or private.staff_can('platform.businesses.read')
  );
create policy addon_grants_service_select on platform.addon_grants for select to service_actor
  using (workspace_id = private.system_scope_workspace());
grant select on platform.addon_grants to authenticated, service_actor;
revoke all on platform.addon_grants from anon;

-- Staff only, one business at a time. Each says whether anything changed, so a second press is visibly a no-op.
create or replace function private.give_addon_grant(p_workspace uuid, p_addon text, p_note text)
returns table (changed boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'Only HandsFreeOS staff hand out an add-on to try'
      using errcode = '42501', detail = 'addon_grant_is_ours';
  end if;
  if not exists (select 1 from app.workspaces w where w.id = p_workspace) then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  insert into platform.addon_grants (workspace_id, addon_id, note, granted_by)
  values (p_workspace, p_addon, nullif(btrim(p_note), ''), auth.uid())
  on conflict (workspace_id, addon_id) do nothing;
  return query select found;
end $$;

create or replace function private.take_back_addon_grant(p_workspace uuid, p_addon text)
returns table (changed boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'Only HandsFreeOS staff hand out an add-on to try'
      using errcode = '42501', detail = 'addon_grant_is_ours';
  end if;
  delete from platform.addon_grants g where g.workspace_id = p_workspace and g.addon_id = p_addon;
  return query select found;
end $$;

revoke execute on function private.give_addon_grant(uuid, text, text) from public;
revoke execute on function private.take_back_addon_grant(uuid, text) from public;
grant execute on function private.give_addon_grant(uuid, text, text) to authenticated;
grant execute on function private.take_back_addon_grant(uuid, text) to authenticated;
