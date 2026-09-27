-- =============================================================================
-- A role handed out carries only what whoever hands it out may do.
--
--        Inviting someone and changing someone's role checked the rank alone.
--        An admin the business had kept from money.manage could invite a
--        second address of their own as an admin, or promote a member, and
--        the new admin had the role's full set: the business's setting for
--        that admin, undone by the admin. membership.invite and
--        membership.change_role now work out what the role would give the
--        person here (packages/core effectivePermissions, the same rules as
--        private.user_permissions()) and refuse anything their caller lacks.
--
--        They need the business's settings for the role, and the person's own,
--        which only permissions.manage reads (0106). This gives exactly those
--        to whoever may invite or change roles here, and nothing to anyone
--        else.
-- =============================================================================

create or replace function private.role_grant_settings(p_ws uuid, p_role app.member_role, p_user uuid default null)
returns table (level text, permission text, allowed boolean)
language sql stable security definer set search_path = '' as $$
  select 'role', o.permission, o.allowed
  from app.role_permission_overrides o
  where o.workspace_id = p_ws and o.role = p_role
    and (private.has_permission(p_ws, 'members.invite') or private.has_permission(p_ws, 'members.change_role'))
  union all
  select 'person', m.permission, m.allowed
  from app.member_permission_overrides m
  where p_user is not null and m.workspace_id = p_ws and m.user_id = p_user
    and private.has_permission(p_ws, 'members.change_role')
$$;

revoke all on function private.role_grant_settings(uuid, app.member_role, uuid) from public;
grant execute on function private.role_grant_settings(uuid, app.member_role, uuid) to authenticated, service_actor;
