-- =============================================================================
-- The founder opens any business as its owner.
--
--        Support looks at a business read-only (M13): with a reason, for a
--        while, and the business is told in its own audit log. That stays
--        for everyone who answers support. The founder gets a second kind of
--        session, the owner's decision (2026-09-30): one click, no reason, no
--        time limit, nothing written into the business's log, and they can
--        change things as its owner would.
--
--        **Who the founder is.** One staff member, marked by hand at the
--        database's own console ("The founder" in docs/operations.md). No
--        request can mark anyone or unmark them, the founder included.
--
--        **What the session changes.** Nothing is stored in the business.
--        The founder never becomes a member, so they are not on its team,
--        are not assigned work, and get none of its notifications. Instead
--        the questions every rule asks about the person asking
--        (has_permission, my_permissions, workspaces_with_permission,
--        accessible_workspace_ids, accessible_organization_ids, and a new
--        my_workspace_role) answer as they would for an owner while the
--        session is open, for that one business. The questions asked about
--        somebody else (user_has_permission, workspace_access) do not
--        change, so nothing that picks people to notify, assign or list
--        finds the founder. Nor does effective_workspace_role, which lists
--        the businesses a person works in: the founder's open business is
--        not one of theirs.
--
--        **What stays.** The platform keeps the session: who, which
--        business, when it started and ended. Changes made while it is open
--        are the founder's own and are recorded under their name, as any
--        owner's are.
-- =============================================================================

-- ---------- who the founder is ----------
alter table platform.staff add column founder boolean not null default false;
comment on column platform.staff.founder is
  'The one person who may open any business as its owner, with no reason and no time limit. Set at the database''s console, never by a request.';
create unique index staff_one_founder on platform.staff (founder) where founder;

-- No request marks anyone the founder or unmarks them: not an admin managing staff, not the worker.
create or replace function private.protect_founder()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and new.founder) or (tg_op = 'UPDATE' and new.founder is distinct from old.founder) then
    if auth.uid() is not null or session_user in ('hfos_api', 'hfos_worker', 'authenticator') then
      raise exception 'Nobody is made the founder from the app' using errcode = '42501', detail = 'founder_fixed';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.protect_founder() from public;

create trigger staff_protect_founder before insert or update of founder on platform.staff
  for each row execute function private.protect_founder();

-- ---------- a session that can change things ----------
alter table platform.view_as_sessions
  add column acts boolean not null default false,
  alter column reason drop not null,
  alter column expires_at drop not null;
comment on column platform.view_as_sessions.acts is
  'The founder working in the business as its owner: no reason, no time limit, and the business is not told. Only the founder opens one.';

alter table platform.view_as_sessions drop constraint view_as_sessions_reason_check;
alter table platform.view_as_sessions add constraint view_as_sessions_reason_check check (
  case when acts then reason is null or length(reason) <= 500
       else reason is not null and length(reason) between 3 and 500 end);
-- A look still ends by itself; only the founder's session waits to be ended.
alter table platform.view_as_sessions add constraint view_as_sessions_look_ends check (
  acts or expires_at is not null);

-- Whether the asker is the founder, still working here.
create or replace function private.i_am_founder()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from platform.staff s
    where s.user_id = auth.uid() and s.founder and s.status = 'active')
$$;
revoke all on function private.i_am_founder() from public;
grant execute on function private.i_am_founder() to authenticated, service_actor;

-- The business the founder has open as its owner right now, or null. At most one: a person has one open session.
create or replace function private.founder_acting_workspace()
returns uuid language sql stable security definer set search_path = '' as $$
  select v.workspace_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active' and s.founder
  join app.workspaces w on w.id = v.workspace_id
  where v.staff_user_id = auth.uid() and v.acts and v.ended_at is null
    and (v.expires_at is null or v.expires_at > now())
    and w.deletion_requested_at is null
  limit 1
$$;
revoke all on function private.founder_acting_workspace() from public;
grant execute on function private.founder_acting_workspace() to authenticated, service_actor;

-- Only the founder writes a session that acts; anyone else's session is a look.
drop policy view_as_write on platform.view_as_sessions;
create policy view_as_write on platform.view_as_sessions for all to authenticated
  using (private.staff_can('platform.view_as') and staff_user_id = (select auth.uid()))
  with check (
    private.staff_can('platform.view_as') and staff_user_id = (select auth.uid())
    and (not acts or private.i_am_founder()));

-- ---------- the questions about the asker, answered as for an owner ----------
-- A session with no end date counts only while its holder is still the founder.
create or replace function private.accessible_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from app.workspace_memberships wm
  join app.workspaces w on w.id = wm.workspace_id
  where wm.user_id = auth.uid() and w.deletion_requested_at is null
  union
  select w.id from app.workspaces w
  join app.organization_memberships om on om.organization_id = w.organization_id
  where om.user_id = auth.uid() and w.deletion_requested_at is null
  union
  select v.workspace_id from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  join app.workspaces w on w.id = v.workspace_id
  where v.staff_user_id = auth.uid() and v.ended_at is null
    and (v.expires_at > now() or (v.expires_at is null and s.founder))
    and w.deletion_requested_at is null
$$;

-- The business's organization too, as for anyone who works in one of its businesses: what the founder changes
-- is recorded (app.events, app.audit_logs) against it, and its name is read beside the business's.
create or replace function private.accessible_organization_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select om.organization_id from app.organization_memberships om where om.user_id = auth.uid()
  union
  select w.organization_id from app.workspaces w
  join app.workspace_memberships wm on wm.workspace_id = w.id
  where wm.user_id = auth.uid()
  union
  select w.organization_id from app.workspaces w where w.id = private.founder_acting_workspace()
$$;

create or replace function private.my_view_as(p_ws uuid)
returns table (session_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select v.id, v.organization_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = auth.uid() and v.workspace_id = p_ws
    and v.ended_at is null and (v.expires_at > now() or (v.expires_at is null and s.founder))
$$;

create or replace function private.active_view_as(p_user uuid, p_ws uuid)
returns table (session_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select v.id, v.organization_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = p_user and v.workspace_id = p_ws
    and v.ended_at is null and (v.expires_at > now() or (v.expires_at is null and s.founder))
$$;

-- The role the asker works with here: the owner's while the founder has it open, else their own. Kept apart from
-- private.effective_workspace_role, which answers "do they work here" for the lists of a person's own businesses
-- (account.me, onboarding, ideas, asking for help): the founder's open business is none of those.
create or replace function private.my_workspace_role(p_ws uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_ws = private.founder_acting_workspace() then 'owner'
              else private.effective_workspace_role(p_ws) end
$$;
revoke all on function private.my_workspace_role(uuid) from public;
grant execute on function private.my_workspace_role(uuid) to authenticated, service_actor;

-- Nobody hands out a role above their own (20260911000500): the founder's is the owner's.
drop policy ws_memberships_update on app.workspace_memberships;
create policy ws_memberships_update on app.workspace_memberships
  for update to authenticated
  using (
    private.has_permission(workspace_id, 'members.change_role')
    and user_id <> (select auth.uid())
    and private.role_rank(role::text) <= private.role_rank(private.my_workspace_role(workspace_id))
  )
  with check (
    private.has_permission(workspace_id, 'members.change_role')
    and user_id <> (select auth.uid())
    and private.role_rank(role::text) <= private.role_rank(private.my_workspace_role(workspace_id))
  );
drop policy ws_memberships_delete on app.workspace_memberships;
create policy ws_memberships_delete on app.workspace_memberships
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (
      private.has_permission(workspace_id, 'members.remove')
      and private.role_rank(role::text) <= private.role_rank(private.my_workspace_role(workspace_id))
    )
  );
drop policy invitations_insert on app.invitations;
create policy invitations_insert on app.invitations
  for insert to authenticated
  with check (
    private.has_permission(workspace_id, 'members.invite')
    and invited_by = (select auth.uid())
    and organization_id = private.workspace_organization(workspace_id)
    and private.role_rank(role::text) <= private.role_rank(private.my_workspace_role(workspace_id))
    -- the worker mints the token; nobody pre-accepts or pre-revokes
    and token_hash is null and sent_at is null
    and accepted_at is null and accepted_by is null
    and revoked_at is null and revoked_by is null
  );

-- An owner decides what becomes of the address of someone who has left (20261013001200); so may the founder.
create or replace function private.reassign_email_address(p_address uuid, p_to uuid, p_remove boolean)
returns table (was uuid, threads integer, media jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_owner uuid;
  v_threads integer := 0;
  v_media jsonb := '[]'::jsonb;
begin
  select a.workspace_id, a.owner_user_id into v_ws, v_owner
  from app.email_addresses a where a.id = p_address for update;
  if not found or v_ws not in (select private.accessible_workspace_ids()) then
    raise exception 'No address with that id' using errcode = 'P0002', detail = 'no_email_address';
  end if;
  if private.my_workspace_role(v_ws) is distinct from 'owner' then
    raise exception 'Only an owner decides what becomes of a person''s address'
      using errcode = '42501', detail = 'email_address_reassign_owner';
  end if;
  if v_owner is null then
    raise exception 'That address is the team''s already' using errcode = '23514', detail = 'email_address_not_owned';
  end if;
  if private.works_in(v_owner, v_ws) then
    raise exception 'That person still works here' using errcode = '23514', detail = 'email_address_owner_still_here';
  end if;
  if p_remove then
    with gone as (
      delete from app.conversations c
      where c.email_address_id = p_address and c.private_to = v_owner
      returning c.id
    )
    select count(*)::int,
      coalesce((select jsonb_agg(f) from app.messages m, jsonb_array_elements(m.media) f
                where m.conversation_id in (select g.id from gone g)), '[]'::jsonb)
    into v_threads, v_media
    from gone;
    delete from app.email_addresses where id = p_address;
  else
    if p_to is not null and not private.works_in(p_to, v_ws) then
      raise exception 'That person doesn''t work here' using errcode = '23514', detail = 'email_address_owner_not_here';
    end if;
    update app.email_addresses set owner_user_id = p_to where id = p_address;
    update app.conversations set private_to = p_to
    where email_address_id = p_address and private_to = v_owner;
    get diagnostics v_threads = row_count;
  end if;
  return query select v_owner, v_threads, v_media;
end $$;

-- An owner holds every owner permission whatever is stored (0106), and so does the founder working as one.
-- Always true or false, never null: rules ask `not private.has_permission(...)` too (inbox_narrowed, money_biller).
create or replace function private.has_permission(p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.user_has_permission(auth.uid(), p_ws, p_perm)
    or coalesce(
      p_ws = private.founder_acting_workspace()
        and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm),
      false)
$$;

create or replace function private.my_permissions(p_ws uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array(
    select wa.p from app.workspace_access a
    join app.workspaces w on w.id = a.workspace_id
    cross join lateral unnest(a.permissions) as wa(p)
    where a.user_id = auth.uid() and a.workspace_id = p_ws and w.deletion_requested_at is null
    union
    select rp.permission from app.role_permissions rp
    where rp.role = 'owner' and p_ws = private.founder_acting_workspace()
    order by 1), '{}'::text[])
$$;

create or replace function private.workspaces_with_permission(p_perm text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wa.workspace_id from app.workspace_access wa
  join app.workspaces w on w.id = wa.workspace_id
  where wa.user_id = auth.uid() and p_perm = any (wa.permissions)
    and w.deletion_requested_at is null
  union
  select f.id from (select private.founder_acting_workspace() as id) f
  where f.id is not null
    and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm)
$$;
