-- =============================================================================
-- Practice businesses: Admin → Try onboarding (2026-11-14).
--
--        HandsFreeOS's admins go through every onboarding as a brand-new
--        customer would, on the real screens, and nothing is kept. A practice
--        business is a real organization and business, made by staff and
--        marked here, with the staff member as its owner:
--
--        - **Marked when it is made, never after.** `practice_ends_at` says
--          it is a practice business and when it goes. Only
--          `private.start_practice` sets it; a person's own update may not
--          touch it, and a real business never becomes one.
--        - **The outside world is pretended.** The worker answers for a
--          practice business with its stand-ins (texts, calls, numbers,
--          payments, connections, domains) and sends its email only to the
--          staff member (apps/worker/src/practice/). Paying for a founding
--          spot is `private.practice_pay`: the plan goes on the business and
--          no spot is held.
--        - **Gone when it ends.** Ending it is deleting the business, as an
--          owner would (`private.request_workspace_deletion`); at
--          `practice_ends_at` the worker's hourly sweep does the same
--          (`private.practice_expire`). Once its business is purged, the
--          organization goes too, its history with it
--          (`private.purge_practice_organization`): nothing of it is kept.
--
-- Only adds: a staff permission, two columns, a table and six functions,
-- and lets the event log, the audit log and the last-owner rule give way
-- while a practice organization is purged.
-- =============================================================================

-- ---------- the staff permission ----------
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.practice.use');

-- ---------- the mark ----------
alter table app.organizations
  add column practice_ends_at timestamptz,
  add column practice_by uuid references app.users (id) on delete set null,
  add constraint organizations_practice_by_is_practice
    check (practice_by is null or practice_ends_at is not null);

comment on column app.organizations.practice_ends_at is
  'A practice business, made from Admin → Try onboarding, and when it is deleted. Null for every real business.';
comment on column app.organizations.practice_by is
  'The HandsFreeOS staff member practising in it: the only person in it, and who its email goes to.';

create index organizations_practice_idx on app.organizations (practice_ends_at)
  where practice_ends_at is not null;

-- Set only by private.start_practice, never changed: a person's own insert or update may not touch either column.
create or replace function private.guard_practice_mark()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated'
     and (case when tg_op = 'INSERT' then new.practice_ends_at is not null or new.practice_by is not null
               else new.practice_ends_at is distinct from old.practice_ends_at
                    or new.practice_by is distinct from old.practice_by end) then
    raise exception 'Only Admin → Try onboarding makes a practice business'
      using errcode = '42501', detail = 'practice_mark_is_ours';
  end if;
  return new;
end $$;

create trigger organizations_guard_practice before insert or update on app.organizations
  for each row execute function private.guard_practice_mark();

create or replace function private.is_practice_organization(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select o.practice_ends_at is not null from app.organizations o where o.id = p_org), false)
$$;

create or replace function private.is_practice_workspace(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select o.practice_ends_at is not null
    from app.workspaces w join app.organizations o on o.id = w.organization_id
    where w.id = p_ws), false)
$$;

revoke all on function private.is_practice_organization(uuid) from public;
revoke all on function private.is_practice_workspace(uuid) from public;
grant execute on function private.is_practice_organization(uuid) to authenticated, service_actor;
grant execute on function private.is_practice_workspace(uuid) to authenticated, service_actor;

-- What the worker needs to answer for a business: whether it is practice, and whose inbox its email goes to.
-- By organization, by business, or both; nothing for a real business.
create or replace function private.practice_run(p_org uuid, p_ws uuid)
returns table (organization_id uuid, ends_at timestamptz, owner_email text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.practice_ends_at, u.email::text
  from app.organizations o
  left join app.users u on u.id = o.practice_by
  where o.practice_ends_at is not null
    and o.id = coalesce(p_org, (select w.organization_id from app.workspaces w where w.id = p_ws))
$$;

revoke all on function private.practice_run(uuid, uuid) from public;
grant execute on function private.practice_run(uuid, uuid) to service_actor;

-- ---------- starting one ----------
-- The organization and its business, both owned by the staff member, the way private.create_organization makes a
-- new customer's. Made while a paid founding spot is on sale, it picks and "pays" first, as theirs would.
create or replace function private.start_practice(
  p_org_name text, p_org_slug text, p_ws_name text, p_ws_slug text,
  p_timezone text, p_industry text, p_hours integer
) returns table (org_id uuid, ws_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_ws uuid;
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
  insert into app.organization_memberships (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into app.workspace_memberships (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
  return query select v_org, v_ws;
end $$;

revoke all on function private.start_practice(text, text, text, text, text, text, integer) from public;
grant execute on function private.start_practice(text, text, text, text, text, text, integer) to authenticated;

-- ---------- "paying" ----------
-- The stand-in for paying for a founding spot: the plan goes on the business as a paid one would, with its free
-- trial if it has one. No spot is held, no grant is made and no card is kept, so nothing counts it and nothing bills it.
create or replace function private.practice_pay(p_ws uuid, p_offer text, p_trial_days integer)
returns app.plan_kind
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_price integer;
  v_billing text;
  v_plan app.plan_kind;
  v_starts timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not private.is_practice_workspace(p_ws) then
    raise exception 'Only a practice business pays this way' using errcode = '42501', detail = 'practice_only';
  end if;
  if not private.has_permission(p_ws, 'money.manage') then
    raise exception 'Not allowed to pay for this business' using errcode = '42501', detail = 'forbidden';
  end if;
  select o.price_cents, o.billing into v_price, v_billing
  from platform.founding_offers o where o.id = p_offer and o.status <> 'draft';
  if not found then
    raise exception 'That plan isn''t on sale' using errcode = 'P0002', detail = 'founding_offer_missing';
  end if;
  select w.organization_id into v_org from app.workspaces w where w.id = p_ws;
  v_plan := case when v_price = 0 then 'founding_free'::app.plan_kind
                 when v_billing = 'monthly' then 'monthly'::app.plan_kind
                 else 'founding_lifetime'::app.plan_kind end;
  v_starts := case when coalesce(p_trial_days, 0) > 0 then now() + make_interval(days => least(p_trial_days, 365)) end;
  insert into app.workspace_plans (workspace_id, organization_id, plan, status, price_cents, trial_ends_at,
                                   current_period_end)
  values (p_ws, v_org, v_plan, 'active', 0, v_starts,
          coalesce(v_starts, now()) + case when v_plan = 'monthly' then interval '1 month' else interval '1 year' end)
  on conflict (workspace_id) do update
    set plan = excluded.plan, status = 'active', trial_ends_at = excluded.trial_ends_at,
        current_period_end = excluded.current_period_end;
  return v_plan;
end $$;

revoke all on function private.practice_pay(uuid, text, integer) from public;
grant execute on function private.practice_pay(uuid, text, integer) to authenticated;

-- ---------- going ----------
-- The practice organizations whose time is up: each of their businesses is marked to be deleted, as an owner's
-- request marks it, and is returned for the worker to queue its deletion. An organization with no business left
-- comes back with a null business, for the worker to purge.
create or replace function private.practice_expire()
returns table (organization_id uuid, workspace_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  update app.workspaces w
     set deletion_requested_at = coalesce(w.deletion_requested_at, now()),
         deletion_requested_by = coalesce(w.deletion_requested_by, o.practice_by)
    from app.organizations o
   where o.id = w.organization_id and o.practice_ends_at <= now();
  return query
    select o.id, w.id
    from app.organizations o
    left join app.workspaces w on w.organization_id = o.id
    where o.practice_ends_at <= now();
end $$;

revoke all on function private.practice_expire() from public;
grant execute on function private.practice_expire() to service_actor;

create table private.organization_purges (
  organization_id uuid primary key
);
revoke all on private.organization_purges from public;

-- True only inside private.purge_practice_organization's own transaction (the row is never committed).
create or replace function private.purging_organization(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.organization_purges p where p.organization_id = p_org)
$$;
grant execute on function private.purging_organization(uuid) to public;

-- The event log and the audit log (as 20261027007800 left them): append-only, except for the business being purged,
-- and now a practice organization being purged.
create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace((to_jsonb(old) ->> 'workspace_id')::uuid) then
    return old;
  end if;
  if tg_op = 'DELETE' and private.purging_organization((to_jsonb(old) ->> 'organization_id')::uuid) then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - array['payload', 'before', 'after']) = (to_jsonb(old) - array['payload', 'before', 'after'])
     and (((to_jsonb(old) ->> 'addon_id') is not null
           and private.purging_addon((to_jsonb(old) ->> 'workspace_id')::uuid, to_jsonb(old) ->> 'addon_id'))
          or private.bin_working((to_jsonb(old) ->> 'workspace_id')::uuid)) then
    return new;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '42501';
end $$;

-- The last owner of an organization (0002): an organization that is going needs no owner left on it.
create or replace function private.protect_last_org_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_organization(old.organization_id) then
    return old;
  end if;
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if not exists (
      select 1 from app.organization_memberships m
      where m.organization_id = old.organization_id and m.role = 'owner' and m.user_id <> old.user_id
    ) then
      raise exception 'An organization must keep at least one Owner' using errcode = '23514', detail = 'last_owner';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- A practice organization once its business is gone: its own history, then the organization, which takes everything
-- else of it along. False while it still has a business (that business goes first) or when it is already gone.
create or replace function private.purge_practice_organization(p_org uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_ends timestamptz;
begin
  select o.practice_ends_at into v_ends from app.organizations o where o.id = p_org;
  if not found then
    return false;
  end if;
  if v_ends is null then
    raise exception 'Only a practice organization is purged this way'
      using errcode = '55000', detail = 'practice_only';
  end if;
  if exists (select 1 from app.workspaces w where w.organization_id = p_org) then
    return false;
  end if;

  insert into private.organization_purges (organization_id) values (p_org) on conflict do nothing;
  delete from app.audit_logs a
   where a.organization_id = p_org
      or a.event_id in (select e.id from app.events e where e.organization_id = p_org);
  delete from app.events e where e.organization_id = p_org;
  delete from app.organizations o where o.id = p_org;
  delete from private.organization_purges p where p.organization_id = p_org;
  return true;
end $$;

revoke all on function private.purge_practice_organization(uuid) from public;
grant execute on function private.purge_practice_organization(uuid) to service_actor;

-- ---------- counted nowhere ----------
-- Admin → Businesses' totals (0070) and Admin → Getting started's counts (20261013001500) leave practice businesses
-- out, as the list does: while one exists it is nobody's sign-up.
create or replace function private.admin_business_totals()
returns table (businesses bigint, new_this_week bigint, active_this_week bigint)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.workspaces w join app.organizations o on o.id = w.organization_id
      where o.practice_ends_at is null),
    (select count(*) from app.workspaces w join app.organizations o on o.id = w.organization_id
      where o.practice_ends_at is null and w.created_at > now() - interval '7 days'),
    (select count(distinct e.workspace_id) from app.events e
      join app.organizations o on o.id = e.organization_id and o.practice_ends_at is null
      where e.created_at > now() - interval '7 days' and e.workspace_id is not null)
  where private.staff_can('platform.businesses.read')
$$;

create or replace function private.admin_onboarding_counts(p_since timestamptz)
returns table (measure text, step text, count bigint)
language sql stable security definer set search_path = '' as $$
  with e as (
    select e.event_type, e.workspace_id, e.actor_id, e.payload
    from app.events e
    join app.organizations o on o.id = e.organization_id and o.practice_ends_at is null
    where e.event_type like 'onboarding.%' and e.created_at > p_since
  ),
  -- A business step is the business's; a step on someone's own list is theirs.
  skips as (
    select e.payload ->> 'step' as step,
           (e.payload ->> 'skipped')::boolean as skipped,
           case when e.payload ->> 'for' = 'person'
                then e.workspace_id::text || ':' || coalesce(e.actor_id::text, '')
                else e.workspace_id::text end as subject
    from e where e.event_type = 'onboarding.step_skipped'
  ),
  counted as (
    select 'started' as measure, null::text as step, count(distinct e.workspace_id) as count
    from e where e.event_type = 'onboarding.answers_saved'
    union all
    select 'as_you_go', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.customers_as_you_go'
      and (e.payload ->> 'asYouGo')::boolean
    union all
    select 'finished', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business'
    union all
    select 'finished_clean', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business'
      and (e.payload ->> 'skipped')::int = 0
    union all
    select 'finished_team', null, count(distinct (e.workspace_id, e.actor_id))
    from e where e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'personal'
    union all
    select 'hidden', null, count(distinct (e.workspace_id, e.actor_id))
    from e where e.event_type = 'onboarding.view_changed' and (e.payload ->> 'hidden')::boolean
    union all
    select 'turned_off', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.enabled_changed'
      and not (e.payload ->> 'enabled')::boolean
    union all
    select case when s.skipped then 'skipped' else 'brought_back' end, s.step,
           count(distinct s.subject)
    from skips s group by 1, 2
  )
  select c.measure, c.step, c.count from counted c
  where private.staff_can('platform.businesses.read')
$$;
