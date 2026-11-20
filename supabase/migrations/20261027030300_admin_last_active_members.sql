-- =============================================================================
-- "Last active" on Admin → Businesses counts only what the business's own
-- people did (the owner, 20 Nov 2026: the last time a real member of that
-- business was active, never staff or an admin looking at it).
--        - Before this, it was the newest event of any kind. HandsFreeOS's own
--          jobs write events too (the daily attention digest, every morning),
--          so almost every business looked active today.
--        - Now it is the newest event a member of that business made
--          themselves: actor_type 'human', by someone with a membership there.
--          The system, workflows, the AI teammate, a customer in their portal,
--          and staff (a founder working in a business is not a member of it)
--          never count. Opening the app without doing anything writes no
--          event, so it doesn't count either.
--        - The same rule decides "Active this week" (admin_business_totals) and
--          the "gone quiet" flag (admin_business_attention), which had the same
--          flaw.
--        - The per-person "last active" on a business's page read app.events
--          under the ordinary rules, which give staff none of a business's
--          events, so it said "never" for everyone. It comes from
--          admin_person_last_active now, which checks the permission itself.
--        - Replaces functions only, with the same signatures and grants, so it
--          can go on before the code.
-- =============================================================================

-- The newest thing a member of the business did themselves. No permission check of its own: only the admin
-- functions below call it, and they check.
create function private.member_last_active(p_ws uuid)
returns timestamptz
language sql stable set search_path = '' as $$
  select max(e.created_at) from app.events e
  where e.workspace_id = p_ws and e.actor_type = 'human'
    and exists (select 1 from app.workspace_memberships m
      where m.workspace_id = p_ws and m.user_id = e.actor_id)
$$;
revoke all on function private.member_last_active(uuid) from public;

-- The last time somebody in a business did anything, for a page of businesses at once.
create or replace function private.admin_last_active(p_ws uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select private.member_last_active(p_ws)
  where private.staff_can('platform.businesses.read')
$$;

-- The last time one person in a business did anything there themselves, for its people on the business's page.
create function private.admin_person_last_active(p_ws uuid, p_user uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(e.created_at) from app.events e
  where e.workspace_id = p_ws and e.actor_id = p_user and e.actor_type = 'human'
    and private.staff_can('platform.businesses.read')
$$;
revoke all on function private.admin_person_last_active(uuid, uuid) from public;
grant execute on function private.admin_person_last_active(uuid, uuid) to authenticated;

-- How much there is of each thing in one business. Counts, never rows: this answers "is anything set up?"
-- and "are they using it?" without showing a single customer.
create or replace function private.admin_business_counts(p_ws uuid)
returns table (
  people bigint, leads bigint, conversations bigint, appointments bigint, invoices bigint,
  has_phone boolean, has_email boolean, has_payments boolean, has_calendar boolean, has_ai boolean,
  last_active_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.people p where p.workspace_id = p_ws and p.archived_at is null),
    (select count(*) from app.leads l where l.workspace_id = p_ws and l.archived_at is null),
    (select count(*) from app.conversations c where c.workspace_id = p_ws),
    (select count(*) from app.appointments a where a.workspace_id = p_ws),
    (select count(*) from app.invoices i where i.workspace_id = p_ws),
    exists (select 1 from app.phone_numbers n where n.workspace_id = p_ws and n.released_at is null),
    exists (select 1 from app.email_addresses e where e.workspace_id = p_ws),
    exists (select 1 from app.payment_connections pc where pc.workspace_id = p_ws and pc.status = 'active'),
    exists (select 1 from app.calendars cal where cal.workspace_id = p_ws and cal.status = 'active'),
    exists (select 1 from app.ai_teammates t where t.workspace_id = p_ws),
    private.member_last_active(p_ws)
  where private.staff_can('platform.businesses.read')
$$;

-- How many businesses there are, how many arrived this week, how many of their people did anything this week.
-- Practice businesses (20261027027400) are left out of all three.
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
      join app.workspace_memberships m on m.workspace_id = e.workspace_id and m.user_id = e.actor_id
      where e.created_at > now() - interval '7 days' and e.workspace_id is not null
        and e.actor_type = 'human')
  where private.staff_can('platform.businesses.read')
$$;

-- What needs a look, most serious first. Keys, never words: core says them. As in 20261027009700, except that
-- gone_quiet now means none of the business's own people has done anything in 14 days.
--   being_deleted       an owner asked to delete the business
--   wallet_suspended    the balance is suspended
--   card_declined       the card on the balance was declined, and still is
--   balance_out         a balance they are shown has run out
--   plan_trouble        the plan's renewal failed, or it is in grace or past due
--   texting_rejected    a texting registration was rejected or failed
--   connection_broken   a payments, calendar, mailbox or Meta connection needs signing in again
--   texting_waiting     a texting registration has waited on the carriers over 10 days
--   thin_margin         30 days of charges came to under 1.2× what they cost us (core's DESK_THIN_MARGIN)
--   gone_quiet          none of the business's own people has done anything in 14 days
--   setup_stalled       a week or more in, Getting started isn't finished (checked for the first 60 days)
create or replace function private.admin_business_attention(p_ws uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  with ws as (
    select w.id, w.created_at, w.deletion_requested_at
    from app.workspaces w
    where w.id = p_ws and private.staff_can('platform.businesses.read')
  ),
  wallet as (
    select uw.stage::text as stage, uw.balance_cents, uw.declines_in_row, uw.suspended_at
    from app.usage_wallets uw where uw.workspace_id = p_ws
  ),
  usage as (
    select coalesce(sum(abs(l.amount_cents)) filter (where l.amount_cents < 0), 0) as charged,
           coalesce(sum(coalesce(l.cost_cents, 0)), 0) as cost
    from app.usage_ledger l
    where l.workspace_id = p_ws and l.occurred_at > now() - interval '30 days'
  ),
  registration as (
    select distinct on (r.kind) r.kind, r.status::text as status,
           coalesce(r.carrier_submitted_at, r.submitted_at, r.created_at) as since
    from app.telephony_registrations r
    where r.workspace_id = p_ws
    order by r.kind, r.created_at desc
  )
  select array_remove(array[
    case when ws.deletion_requested_at is not null then 'being_deleted' end,
    case when exists (select 1 from wallet where suspended_at is not null) then 'wallet_suspended' end,
    case when exists (select 1 from wallet where declines_in_row > 0) then 'card_declined' end,
    case when exists (select 1 from wallet where stage in ('warn', 'enforce') and balance_cents <= 0)
      then 'balance_out' end,
    case when exists (select 1 from app.workspace_plans p where p.workspace_id = p_ws
        and (p.status in ('grace', 'past_due') or p.renewal_problem is not null))
      then 'plan_trouble' end,
    case when exists (select 1 from registration where status in ('rejected', 'failed'))
      then 'texting_rejected' end,
    case when exists (select 1 from app.payment_connections c where c.workspace_id = p_ws
          and c.status in ('reauth_required', 'error'))
        or exists (select 1 from app.calendar_connections c where c.workspace_id = p_ws
          and c.status in ('reauth_required', 'error'))
        or exists (select 1 from app.mailbox_connections c where c.workspace_id = p_ws
          and c.status in ('reauth_required', 'error'))
        or exists (select 1 from app.meta_connections c where c.workspace_id = p_ws
          and c.status = 'needs_attention')
      then 'connection_broken' end,
    case when exists (select 1 from registration where status in ('submitted', 'in_review')
        and since < now() - interval '10 days')
      then 'texting_waiting' end,
    case when exists (select 1 from usage where cost > 0 and charged < cost * 1.2) then 'thin_margin' end,
    case when ws.created_at < now() - interval '14 days'
        and coalesce(private.member_last_active(p_ws), ws.created_at) < now() - interval '14 days'
      then 'gone_quiet' end,
    -- Nested so the events are only read for a business of the right age.
    case when ws.created_at between now() - interval '60 days' and now() - interval '7 days' then
      case when not exists (select 1 from app.events e where e.workspace_id = p_ws
          and e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business')
        and coalesce((select (e.payload ->> 'enabled')::boolean from app.events e
          where e.workspace_id = p_ws and e.event_type = 'onboarding.enabled_changed'
          order by e.created_at desc limit 1), true)
      then 'setup_stalled' end
    end
  ], null)
  from ws
$$;
