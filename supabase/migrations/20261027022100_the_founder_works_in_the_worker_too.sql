-- =============================================================================
-- The founder's open business works in the worker's routes too.
--
--        The founder opens any business as its owner (20261013002100). The
--        rules ask about the person asking through auth.uid() (has_permission
--        and the rest), and those answer as for an owner while the session is
--        open. The worker's own routes (Phone & texting, finding and moving
--        numbers, Match my website, calling from the browser, …) check the
--        person asking by id instead, with user_has_permission. That one is
--        about somebody else and, on purpose, never counts the founder's
--        session. So inside a business the founder had open, every worker
--        route said no: Phone & texting read Off with its switch greyed out
--        while the business's own Twilio account was on.
--
--        asker_has_permission is user_has_permission for the person asking a
--        request, by id: the same answer has_permission gives them when the
--        database knows them as auth.uid(). user_has_permission is unchanged,
--        so nothing that picks people to notify, assign or ring finds the
--        founder.
--
--        founder_acting_workspace keeps its rule in one place: it now asks
--        founder_acting_workspace_of about auth.uid(), the same question the
--        worker asks about the person it signed in.
-- =============================================================================

-- The business this person has open as its owner right now, as the founder, or null.
create or replace function private.founder_acting_workspace_of(p_user uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select v.workspace_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active' and s.founder
  join app.workspaces w on w.id = v.workspace_id
  where v.staff_user_id = p_user and v.acts and v.ended_at is null
    and (v.expires_at is null or v.expires_at > now())
    and w.deletion_requested_at is null
  limit 1
$$;
revoke all on function private.founder_acting_workspace_of(uuid) from public;
grant execute on function private.founder_acting_workspace_of(uuid) to service_actor;

create or replace function private.founder_acting_workspace()
returns uuid language sql stable security definer set search_path = '' as $$
  select private.founder_acting_workspace_of(auth.uid())
$$;

-- What has_permission answers for the person asking, asked by their id: the worker's routes, which sign the
-- person in themselves and then ask as the system. Always true or false, never null.
create or replace function private.asker_has_permission(p_user uuid, p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.user_has_permission(p_user, p_ws, p_perm)
    or coalesce(
      p_ws = private.founder_acting_workspace_of(p_user)
        and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm),
      false)
$$;
revoke all on function private.asker_has_permission(uuid, uuid, text) from public;
grant execute on function private.asker_has_permission(uuid, uuid, text) to service_actor;
