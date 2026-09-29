-- =============================================================================
-- When a business's owners last signed in, for an agency's Setup column
-- (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6): a business whose owners
-- haven't been in for five days, with must-dos still open, is stuck. Only the
-- auth server knows when someone signed in, and nothing reads auth.users
-- directly, so this answers that one thing about one business: the latest
-- sign-in of any of its own owners (not the agency's people, who own every
-- business through the organization).
--
-- Asked by the organization's owners and admins (org.templates.manage), or by
-- the worker bound to the business (the daily agency digest). Anyone else gets
-- null.
-- =============================================================================

create or replace function private.owners_last_sign_in(p_ws uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select max(u.last_sign_in_at)
  from app.workspaces w
  join app.workspace_memberships m on m.workspace_id = w.id and m.role = 'owner'
  join auth.users u on u.id = m.user_id
  where w.id = p_ws
    and not exists (
      select 1 from app.organization_memberships om
      where om.organization_id = w.organization_id and om.user_id = m.user_id)
    and (private.has_org_permission(w.organization_id, 'org.templates.manage')
         or w.id = private.system_scope_workspace())
$$;

revoke all on function private.owners_last_sign_in(uuid) from public;
grant execute on function private.owners_last_sign_in(uuid) to authenticated, service_actor;
