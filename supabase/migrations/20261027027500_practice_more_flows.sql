-- =============================================================================
-- Practice businesses, part 2: the other onboardings (2026-11-14).
--
--        Admin → Try onboarding (20261027027400) started with a brand-new
--        customer's sign-up. Its other onboardings need a practice business
--        made three ways, all marked and deleted as before:
--
--        - **Yours** (`owner`): as a new customer's, now also **ready**, its
--          plan already "paid", for an add-on's setup or the Main offer
--          builder.
--        - **An agency's client** (`agency`): the staff member owns the
--          agency (the organization) and isn't on the business's team, as an
--          agency setting up a client is. Its setup ends by handing it to
--          the owner, which invites them.
--        - **Joined from an invitation** (`invited`): nobody is in it yet. The
--          staff member is invited at the role they picked, from their own
--          address, and joins it as a new teammate would. It's ready, since a
--          teammate can't pay for it.
--
--        Every invitation into a practice business is pretended: the staff
--        member practising it may accept one whatever address it went to,
--        the agency's handover above among them. And since in the last two
--        the staff member may hold no role that deletes a business, ending
--        one is theirs by being who practises it (`private.end_practice`).
--
-- Only adds: six functions. It redefines three more: starting one (now the
-- first way of the new one), and an invitation's preview and acceptance, which
-- let the person practising a business take its invitations.
-- =============================================================================

-- ---------- starting one, three ways ----------
create or replace function private.start_practice_as(
  p_org_name text, p_org_slug text, p_ws_name text, p_ws_slug text,
  p_timezone text, p_industry text, p_hours integer,
  p_as text, p_role app.member_role, p_ready boolean
) returns table (org_id uuid, ws_id uuid, invitation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_org uuid;
  v_ws uuid;
  v_inv uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not private.staff_can('platform.practice.use') then
    raise exception 'Only HandsFreeOS admins practise onboarding' using errcode = '42501', detail = 'practice_forbidden';
  end if;
  if p_hours is null or p_hours not between 1 and 168 then
    raise exception 'A practice business lasts 1 to 168 hours' using errcode = '22023', detail = 'practice_hours';
  end if;
  if p_as is null or p_as not in ('owner', 'agency', 'invited') then
    raise exception 'A practice business is yours, an agency''s client or joined from an invitation'
      using errcode = '22023', detail = 'practice_as';
  end if;
  if p_as = 'invited' and coalesce(p_role, 'member') = 'owner' then
    raise exception 'Practise joining as an admin or a member; an owner joins through an agency''s handover'
      using errcode = '22023', detail = 'practice_role';
  end if;
  -- Five at once is plenty; each is a whole business until it goes.
  if (select count(*) from app.organizations o where o.practice_by = v_uid) >= 5 then
    raise exception 'Five practice businesses at once' using errcode = '23514', detail = 'practice_too_many';
  end if;
  insert into app.organizations (name, slug, created_by, practice_ends_at, practice_by)
    values (btrim(p_org_name), p_org_slug, v_uid, now() + make_interval(hours => p_hours), v_uid)
    returning id into v_org;
  insert into app.workspaces (organization_id, name, slug, timezone, industry, created_by)
    values (v_org, btrim(p_ws_name), p_ws_slug, coalesce(p_timezone, 'America/Chicago'),
            coalesce(p_industry, 'home_services'), v_uid)
    returning id into v_ws;
  if p_as in ('owner', 'agency') then
    insert into app.organization_memberships (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  end if;
  if p_as = 'owner' then
    insert into app.workspace_memberships (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
  end if;
  -- Invited: in it as a member only while practice.start records what it made, which only someone in a business
  -- records (events_insert); it steps them out straight after (private.practice_step_out).
  if p_as = 'invited' then
    insert into app.workspace_memberships (workspace_id, user_id, role) values (v_ws, v_uid, 'member');
  end if;
  if p_as = 'invited' then
    select u.email::text into v_email from app.users u where u.id = v_uid;
    if v_email is null then
      raise exception 'User profile missing' using errcode = 'P0002', detail = 'profile_missing';
    end if;
    -- As membership.invite writes one: the worker makes its link and sends it (to the staff member, marked [Practice]).
    insert into app.invitations (organization_id, workspace_id, email, role, invited_by, expires_at)
      values (v_org, v_ws, v_email, coalesce(p_role, 'member'), v_uid, now() + interval '7 days')
      returning id into v_inv;
  end if;
  -- Ready: the plan is on it, as the stand-in checkout puts one, so nothing waits on a founding spot.
  if p_ready or p_as = 'invited' then
    insert into app.workspace_plans (workspace_id, organization_id, plan, status, price_cents, current_period_end)
      values (v_ws, v_org, 'founding_lifetime', 'active', 0, now() + interval '1 year')
      on conflict (workspace_id) do nothing;
  end if;
  return query select v_org, v_ws, v_inv;
end $$;

revoke all on function private.start_practice_as(text, text, text, text, text, text, integer, text, app.member_role, boolean) from public;
grant execute on function private.start_practice_as(text, text, text, text, text, text, integer, text, app.member_role, boolean) to authenticated;

-- The first way, as 20261027027400 made it (the running code calls it until this part ships).
create or replace function private.start_practice(
  p_org_name text, p_org_slug text, p_ws_name text, p_ws_slug text,
  p_timezone text, p_industry text, p_hours integer
) returns table (org_id uuid, ws_id uuid)
language sql security definer set search_path = '' as $$
  select s.org_id, s.ws_id
  from private.start_practice_as(p_org_name, p_org_slug, p_ws_name, p_ws_slug, p_timezone, p_industry, p_hours,
                                 'owner', null, false) s
$$;

-- Straight after practice.start has recorded a business it's inviting them into: out of it again, so they join it
-- from the invitation as a new teammate does. Only theirs, only one with their invitation waiting, and only while
-- they're in it as nothing more than that member.
create or replace function private.practice_step_out(p_ws uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not exists (
    select 1 from app.workspaces w
    join app.organizations o on o.id = w.organization_id
    join app.users u on u.id = v_uid
    join app.invitations i on i.workspace_id = w.id and lower(i.email::text) = lower(u.email::text)
      and i.accepted_at is null and i.revoked_at is null
    where w.id = p_ws and o.practice_by = v_uid
      and not exists (select 1 from app.organization_memberships m
                      where m.organization_id = o.id and m.user_id = v_uid)
  ) then
    raise exception 'Only a practice business you were just invited into' using errcode = '42501', detail = 'practice_only';
  end if;
  delete from app.workspace_memberships m where m.workspace_id = p_ws and m.user_id = v_uid and m.role = 'member';
  return found;
end $$;

revoke all on function private.practice_step_out(uuid) from public;
grant execute on function private.practice_step_out(uuid) to authenticated;

-- Ending one they were invited into and never joined: in it as a member just long enough for practice.end to record
-- the deletion, which only someone in a business records. It goes with the business.
create or replace function private.practice_step_in(p_ws uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not private.staff_can('platform.practice.use') or not exists (
    select 1 from app.workspaces w join app.organizations o on o.id = w.organization_id
    where w.id = p_ws and w.deletion_requested_at is null
      and o.practice_ends_at is not null and o.practice_by = v_uid
  ) then
    raise exception 'Only a practice business of yours' using errcode = '42501', detail = 'practice_only';
  end if;
  if private.effective_workspace_role(p_ws) is not null then
    return false;
  end if;
  insert into app.workspace_memberships (workspace_id, user_id, role) values (p_ws, v_uid, 'member');
  return true;
end $$;

revoke all on function private.practice_step_in(uuid) from public;
grant execute on function private.practice_step_in(uuid) to authenticated;

-- ---------- whose they are ----------
-- The practice businesses this person has going, whether or not they're in them yet (an invitation not yet taken),
-- with whether they are. Row security would hide one they haven't joined.
create or replace function private.practice_mine()
returns table (organization_id uuid, workspace_id uuid, name text, created_at timestamptz, ends_at timestamptz,
               joined boolean, invited boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, w.id, coalesce(w.name, o.name), o.created_at, o.practice_ends_at,
         w.id is not null and private.effective_workspace_role(w.id) is not null,
         w.id is not null and exists (
           select 1 from app.invitations i
           where i.workspace_id = w.id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
  from app.organizations o
  left join app.workspaces w on w.organization_id = o.id and w.deletion_requested_at is null
  where o.practice_by = auth.uid() and o.practice_ends_at is not null
  order by o.created_at desc, w.created_at
$$;

revoke all on function private.practice_mine() from public;
grant execute on function private.practice_mine() to authenticated;

-- ---------- ending one ----------
-- As private.request_workspace_deletion marks one, for the person practising it, whatever role they hold there (a
-- teammate who joined from an invitation holds none that deletes).
create or replace function private.end_practice(p_ws uuid)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not private.staff_can('platform.practice.use') then
    raise exception 'Only HandsFreeOS admins practise onboarding' using errcode = '42501', detail = 'practice_forbidden';
  end if;
  if not exists (select 1 from app.workspaces w where w.id = p_ws) then
    raise exception 'Workspace not found' using errcode = 'P0002', detail = 'workspace_missing';
  end if;
  if not private.is_practice_workspace(p_ws) then
    raise exception 'Only a practice business ends this way' using errcode = '42501', detail = 'practice_only';
  end if;
  if not exists (
    select 1 from app.workspaces w join app.organizations o on o.id = w.organization_id
    where w.id = p_ws and o.practice_by = v_uid
  ) then
    raise exception 'Someone else is practising that business' using errcode = '42501', detail = 'practice_not_yours';
  end if;
  update app.workspaces w
     set deletion_requested_at = coalesce(w.deletion_requested_at, now()),
         deletion_requested_by = coalesce(w.deletion_requested_by, v_uid)
   where w.id = p_ws
  returning w.deletion_requested_at into v_at;
  return v_at;
end $$;

revoke all on function private.end_practice(uuid) from public;
grant execute on function private.end_practice(uuid) to authenticated;

-- ---------- invitations into a practice business ----------
-- Whoever an invitation into a practice business went to, the person practising it takes it: every address in one is
-- pretended, its email came to them, and it's them who goes on as the owner or teammate (20260911000500 otherwise).
create or replace function private.practice_invitation_for(p_ws uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.workspaces w join app.organizations o on o.id = w.organization_id
    where w.id = p_ws and o.practice_ends_at is not null and o.practice_by = p_uid)
$$;

revoke all on function private.practice_invitation_for(uuid, uuid) from public;

create or replace function private.invitation_preview(p_token_hash bytea)
returns table (
  status text, workspace_name text, organization_name text, inv_role app.member_role,
  inviter_name text, invitee_email_masked text, expires_at timestamptz, email_matches boolean
)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv app.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  select u.email::text into v_email from app.users u where u.id = v_uid;
  select * into v_inv from app.invitations i where i.token_hash = p_token_hash;
  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002', detail = 'invitation_not_found';
  end if;
  return query
    select
      case
        when v_inv.revoked_at is not null then 'revoked'
        when v_inv.accepted_at is not null then 'used'
        when v_inv.expires_at <= now() then 'expired'
        else 'pending'
      end,
      w.name, o.name, v_inv.role,
      coalesce(nullif(u.full_name, ''), u.email::text),
      left(v_inv.email::text, 1) || '••••' || substring(v_inv.email::text from '@.*$'),
      v_inv.expires_at,
      lower(v_inv.email::text) = lower(coalesce(v_email, ''))
        or private.practice_invitation_for(v_inv.workspace_id, v_uid)
    from app.workspaces w
    join app.organizations o on o.id = w.organization_id
    left join app.users u on u.id = v_inv.invited_by
    where w.id = v_inv.workspace_id;
end $$;

create or replace function private.accept_invitation(p_token_hash bytea)
returns table (inv_id uuid, org_id uuid, ws_id uuid, inv_role app.member_role, inv_email text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv app.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  select u.email::text into v_email from app.users u where u.id = v_uid;
  if v_email is null then
    raise exception 'User profile missing' using errcode = 'P0002', detail = 'profile_missing';
  end if;
  select * into v_inv from app.invitations i where i.token_hash = p_token_hash for update;
  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002', detail = 'invitation_not_found';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'Invitation revoked' using errcode = 'P0001', detail = 'invitation_revoked';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'Invitation already used' using errcode = 'P0001', detail = 'invitation_used';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'Invitation expired' using errcode = 'P0001', detail = 'invitation_expired';
  end if;
  if lower(v_inv.email::text) <> lower(v_email)
     and not private.practice_invitation_for(v_inv.workspace_id, v_uid) then
    raise exception 'Invitation was sent to a different email' using errcode = 'P0001', detail = 'invitation_email_mismatch';
  end if;

  insert into app.workspace_memberships (workspace_id, user_id, role)
  values (v_inv.workspace_id, v_uid, v_inv.role)
  on conflict (workspace_id, user_id) do update
    set role = case
      when private.role_rank(excluded.role::text) > private.role_rank(app.workspace_memberships.role::text)
      then excluded.role else app.workspace_memberships.role end;

  update app.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;

  return query select v_inv.id, v_inv.organization_id, v_inv.workspace_id, v_inv.role, v_inv.email::text;
end $$;
