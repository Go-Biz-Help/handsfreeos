-- =============================================================================
-- The worker can read who the founder is, in a business they've worked in.
--
--        The founder opens any business as its owner (20261013002100), and
--        what they do there is theirs: the event names them as its actor.
--        But the worker reads people as the service actor, scoped to the
--        business, and app.users showed it only the business's own members
--        (users_service_select). So any worker step that looked up the person
--        who did something found nobody when it was the founder.
--
--        It showed on 2026-11-16: the founder pressed Send on "Email your web
--        person" in a client's business, the worker couldn't find who sent
--        it, and skipped the email without a word. The same look-up runs for
--        a workflow they started, a document they sent and more.
--
--        Now the worker also sees the founder's own user row in a business
--        they've opened to work in, once or now. Not only while it's open: an
--        event they caused can be retried after they've left. Every worker
--        read of app.users asks for one person by id, or joins the members;
--        the founder is no member, so nobody's list of people gains them.
--        Only app.users changes: their phones, pushes and the rest stay the
--        members' alone.
-- =============================================================================

-- The founder, when they have opened the business the worker is scoped to as its owner: zero or one id.
create or replace function private.system_scope_founder_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select s.user_id
  from platform.staff s
  where s.founder and s.status = 'active'
    and exists (
      select 1 from platform.view_as_sessions v
      where v.staff_user_id = s.user_id and v.acts
        and v.workspace_id = private.system_scope_workspace())
$$;
revoke all on function private.system_scope_founder_ids() from public;
grant execute on function private.system_scope_founder_ids() to service_actor;

create policy users_service_select_founder on app.users for select to service_actor
  using (id in (select private.system_scope_founder_ids()));
