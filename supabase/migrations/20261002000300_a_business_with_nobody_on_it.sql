-- =============================================================================
-- 0091 · The business you add is a business you are on.
--
--        A workspace membership is written in exactly two places: the bootstrap
--        function that makes the organization and its first workspace at
--        sign-up, and accepting an invitation. Both are `security definer`,
--        because `app.workspace_memberships` has no insert policy at all — a
--        signed-in role may read, change and remove memberships, and may never
--        create one. That is deliberate: who is on a business is not something
--        a tenant writes directly.
--
--        `workspace.create` is neither of those. "Add another business" made
--        the workspace and stopped, so every workspace added to an existing
--        organization had nobody on it. Administering the organization is what
--        lets you open such a workspace; being a member is what puts you in it,
--        and nearly everything inside one is scoped to its members. With no
--        rows `schedule.team` returns nobody, so Calendar has nobody to show,
--        nobody can be booked or assigned, and — since the only ways in are an
--        invitation somebody has to send and a bootstrap that already ran —
--        there is no way to add the first person from the app at all.
--
--        So the creator joins as an owner, through a function of the same kind
--        the other two use rather than an insert policy: an insert policy would
--        be a standing permission to write memberships, which is the thing the
--        table is built not to have. This one writes a single row, for the
--        caller and nobody else, as an owner and no other role, and only into a
--        workspace whose organization the caller already administers — which is
--        the same test that let them create the workspace a moment earlier.
-- =============================================================================

create or replace function private.add_workspace_owner(p_workspace uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  if v_org is null then
    raise exception 'Workspace not found' using errcode = 'P0002', detail = 'workspace_missing';
  end if;
  -- Any membership of the organization is owner or admin (app.org_role has no other value), and that
  -- is exactly who `workspace.create` lets create a workspace here in the first place.
  if private.org_role(v_org) is null then
    raise exception 'Not allowed' using errcode = '42501', detail = 'not_org_member';
  end if;
  insert into app.workspace_memberships (workspace_id, user_id, role)
  values (p_workspace, v_uid, 'owner')
  on conflict (workspace_id, user_id) do nothing
  returning id into v_id;
  -- Already on it: hand back the row that is there rather than a null.
  if v_id is null then
    select m.id into v_id from app.workspace_memberships m
    where m.workspace_id = p_workspace and m.user_id = v_uid;
  end if;
  return v_id;
end $$;

revoke all on function private.add_workspace_owner(uuid) from public;
grant execute on function private.add_workspace_owner(uuid) to authenticated;
