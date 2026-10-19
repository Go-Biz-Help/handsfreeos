-- =============================================================================
-- The $497 founding seat is paid by the year.
--
--        **The owner's call (2026-10-19):** the Founding Customer seat was
--        $497 once, for as long as HandsFreeOS exists. It is $497 a year
--        now, renewed on its own. The seat, its cap, its claim link and its
--        place in the chain (0092) are unchanged; what changes is that the
--        money comes round again. The offer's id and its plan kind keep the
--        names they were born with (`founding_lifetime`): ids are names, not
--        promises, and every link, event and analytics row already carries
--        them.
--
--        **`paid_yearly` says how it is paid.** A yearly seat is still a
--        seat paid at Checkout, so its `billing` stays `once` and everything
--        that tells a seat from the monthly plan (the cap, applications, the
--        chain) treats it exactly as before. What the app calls its billing is
--        `yearly` when `paid_yearly` is set (`private.founding_offer_billing`).
--
--        **Shaped like RCS's yearly renewal** (0104). The first year is paid
--        at Stripe Checkout, which keeps the card; a year on, the worker's
--        hourly sweep (`private.founding_renewals_due`) charges it and moves
--        the year on. The year lives on the workspace's plan
--        (`current_period_end`, which 0091 left for exactly this), beside
--        the card it is charged to.
--
--        **A refused card is not tried again on its own.** The business is
--        told, and pays that year on a page of its own with another card: a
--        founding checkout with `renewal_for` set, so the page, the webhook
--        and the return page are the ones a first payment already uses. The
--        plan shows `past_due` meanwhile and the seat stays on — taking it
--        back is staff's decision, from /admin, as it always was.
--
--        **A business may stop it renewing**, and start it again while the
--        year is still paid for. A seat that was stopped goes back when its
--        year is up: the grant is revoked with the reason written for staff,
--        the plan is `canceled` (them leaving, not us), and the seat is free
--        for somebody else.
--
--        **A seat staff give is a gift.** `founding.give` puts no date and no
--        card on the plan, so there is nothing to renew and nothing charged.
--
--        **Only adds.** Nothing is removed, so the code running now keeps
--        working: the four-argument `private.founding_checkout_paid` still
--        answers (by asking the new one with no card), and the two functions
--        whose answers grew have successors beside them rather than new
--        shapes (`founding_checkout_state` beside `founding_checkout_view`,
--        `founding_offer_billing` beside `founding_seat_by_token`). The old
--        ones go in a later migration. Nothing here changes an offer either:
--        `20261027009600_the_497_seat_goes_yearly.sql` does, once the code
--        that knows the word `yearly` has shipped.
-- =============================================================================

-- ---------- how a seat is paid ----------
alter table platform.founding_offers
  /** A seat paid each year, renewed on its own, rather than once. Its `billing` stays `once`: it is a seat. */
  add column paid_yearly boolean not null default false;

/** How an offer is paid, in the app's words: `once`, `yearly` or `monthly`. Nothing secret, so anybody may ask. */
create or replace function private.founding_offer_billing(p_offer text)
returns text
language sql stable security definer set search_path = '' as $$
  select case when o.paid_yearly then 'yearly' else o.billing end
  from platform.founding_offers o where o.id = p_offer
$$;

revoke all on function private.founding_offer_billing(text) from public;
grant execute on function private.founding_offer_billing(text) to authenticated, service_actor;

-- ---------- the paid year, on the plan ----------
alter table app.workspace_plans
  /** The card the yearly renewal is charged to (Stripe's `pm_…`). An id only; Stripe holds the card. */
  add column stripe_card_id text check (length(stripe_card_id) <= 100),
  /** Somebody in the business stopped it renewing. The seat stays until `current_period_end`, then goes back. */
  add column renewal_stopped_at timestamptz,
  add column renewal_stopped_by uuid references app.users (id) on delete set null,
  add column renewal_count integer not null default 0 check (renewal_count >= 0),
  /** The last renewal the card refused, until it is paid on a page of its own. Nothing is charged while it is set. */
  add column renewal_problem text check (renewal_problem is null or length(renewal_problem) <= 1000),
  add column renewal_failed_at timestamptz;

comment on column app.workspace_plans.current_period_end is
  'The end of the year paid for, on a yearly founding seat (20261027009500). The renewal is charged then and moves it on a '
  'year. Null on a plan nobody is billed for.';

-- What the renewal sweep reads.
create index workspace_plans_renewal_idx on app.workspace_plans (current_period_end)
  where current_period_end is not null and renewal_failed_at is null;

-- ---------- a renewal paid on a page of its own ----------
alter table platform.founding_checkouts
  /** Set on a page paying a refused renewal: the `current_period_end` it renews. Null on a first payment. */
  add column renewal_for timestamptz;

-- ---------- what the website reads ----------
-- 0092's view, saying `yearly` for a seat paid each year. Same columns, same order; nothing else changes.
create or replace view platform.founding_counts as
  select o.id, o.name, o.blurb, o.status, o.price_cents, o.seat_cap,
         private.founding_seats_held(o.id) as claimed,
         greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining,
         o.sort,
         case when o.paid_yearly then 'yearly' else o.billing end as billing,
         o.show_counter,
         exists (select 1 from platform.founding_offers n
                  where n.opens_after_offer_id = o.id and n.status <> 'draft' and n.billing = 'once')
           as superseded
  from platform.founding_offers o
  where o.status <> 'draft';

-- ---------- taking a seat up ----------
/**
 * 0093's activation, clearing whatever a yearly seat left on the plan before: a seat taken up here starts with no
 * year, no price and no card, and a yearly payment writes its own just after (below). Otherwise a free seat put on
 * a workspace that once paid by the year would still look like one that renews.
 */
create or replace function private.founding_activate(p_grant uuid, p_workspace uuid)
returns table (plan app.plan_kind, credited_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_price integer;
  v_plan app.plan_kind;
  v_credited bigint;
begin
  select g.organization_id, o.price_cents into v_org, v_price
  from platform.founding_grants g
  join platform.founding_offers o on o.id = g.offer_id
  where g.id = p_grant;

  update platform.founding_grants
     set status = 'active', workspace_id = p_workspace, activated_at = now(), expires_at = null
   where id = p_grant and status in ('reserved', 'expired');
  if not found then
    raise exception 'Grant % cannot be taken up', p_grant
      using errcode = '23514', detail = 'founding_claim_invalid';
  end if;

  v_plan := case when v_price = 0 then 'founding_free'::app.plan_kind else 'founding_lifetime'::app.plan_kind end;

  insert into app.workspace_plans (workspace_id, organization_id, plan, status, grant_id, price_cents)
  values (p_workspace, v_org, v_plan, 'active', p_grant, 0)
  on conflict (workspace_id) do update
    set plan = excluded.plan, status = 'active', grant_id = excluded.grant_id, price_cents = 0,
        grace_ends_at = null, canceled_at = null, current_period_end = null, stripe_card_id = null,
        renewal_stopped_at = null, renewal_stopped_by = null, renewal_count = 0, renewal_problem = null,
        renewal_failed_at = null;

  select c.credited_cents into v_credited from private.founding_credit_wallet(p_grant) c;

  return query select v_plan, coalesce(v_credited, 0::bigint);
end $$;

revoke all on function private.founding_activate(uuid, uuid) from public;

-- ---------- the money is in ----------
/**
 * 0093's payment, with the card it kept and the year it pays for.
 *
 * A first payment turns the seat on as before (`private.founding_activate`); on a yearly offer the plan then carries
 * the price, a year from today, and the card. A renewal page (`renewal_for` set) turns nothing on: it moves the
 * paid year on from the one it was made for, clears the refusal, and makes its card next year's. A renewal page
 * paid after that year already moved — or after the seat was taken back — is recorded for staff, never charged
 * twice: `no_seat`, with the reason on the checkout.
 *
 * `outcome` is `activated`, `renewed`, `already` or `no_seat`.
 */
create or replace function private.founding_checkout_paid(
  p_checkout uuid,
  p_session_ref text,
  p_payment_ref text,
  p_paid_cents integer,
  p_customer_ref text,
  p_card_ref text
)
returns table (outcome text, grant_id uuid, offer_id text, plan app.plan_kind, credited_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_c record;
  v_yearly boolean;
  v_done record;
  v_plan record;
begin
  select c.id, c.status, c.grant_id, c.offer_id, c.workspace_id, c.amount_cents, c.renewal_for into v_c
  from platform.founding_checkouts c
  where c.id = p_checkout
  for update;

  if v_c.id is null then
    raise exception 'There is no checkout %', p_checkout
      using errcode = '23503', detail = 'founding_checkout_missing';
  end if;
  if v_c.status = 'paid' then
    return query select 'already'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end if;

  update platform.founding_checkouts
     set status = 'paid', paid_at = now(), closed_at = now(),
         session_ref = coalesce(session_ref, p_session_ref), payment_ref = p_payment_ref,
         paid_cents = p_paid_cents
   where id = p_checkout;

  if coalesce(p_paid_cents, 0) < v_c.amount_cents then
    update platform.founding_checkouts
       set problem = format('Stripe says %s cents were paid; the seat costs %s. The seat was not turned on.',
                            coalesce(p_paid_cents, 0), v_c.amount_cents)
     where id = p_checkout;
    return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end if;

  -- A refused renewal, paid with another card: the year it was made for moves on, if it is still that year.
  if v_c.renewal_for is not null then
    select p.workspace_id, p.plan, p.current_period_end into v_plan
    from app.workspace_plans p
    join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
    where p.workspace_id = v_c.workspace_id and p.grant_id = v_c.grant_id
    for update of p;
    if v_plan.workspace_id is null or v_plan.current_period_end is distinct from v_c.renewal_for then
      update platform.founding_checkouts
         set problem = case when v_plan.workspace_id is null
                         then 'Paid a renewal, but the seat was taken back first. Refund it, or put the seat back.'
                         else 'Paid a renewal for a year that was already paid. Refund it.' end
       where id = p_checkout;
      return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
      return;
    end if;
    update app.workspace_plans
       set current_period_end = v_c.renewal_for + interval '1 year',
           renewal_count = renewal_count + 1, renewal_problem = null, renewal_failed_at = null,
           status = 'active',
           stripe_customer_id = coalesce(p_customer_ref, stripe_customer_id),
           stripe_card_id = coalesce(p_card_ref, stripe_card_id)
     where workspace_id = v_c.workspace_id;
    return query select 'renewed'::text, v_c.grant_id, v_c.offer_id, v_plan.plan, 0::bigint;
    return;
  end if;

  begin
    select * into v_done from private.founding_activate(v_c.grant_id, v_c.workspace_id);
  exception when check_violation then
    -- Revoked meanwhile (founding_claim_invalid), or lapsed and given away (founding_offer_full): as in 0093.
    update platform.founding_checkouts
       set problem = left('Paid, but the seat could not be turned on: ' || sqlerrm, 1000)
     where id = p_checkout;
    return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end;

  -- A seat paid by the year carries its year, its price and its card from the first payment.
  select o.paid_yearly into v_yearly from platform.founding_offers o where o.id = v_c.offer_id;
  if v_yearly then
    update app.workspace_plans
       set price_cents = v_c.amount_cents,
           current_period_end = now() + interval '1 year',
           stripe_customer_id = p_customer_ref, stripe_card_id = p_card_ref,
           renewal_count = 0, renewal_problem = null, renewal_failed_at = null,
           renewal_stopped_at = null, renewal_stopped_by = null
     where workspace_id = v_c.workspace_id;
  end if;

  return query select 'activated'::text, v_c.grant_id, v_c.offer_id, v_done.plan, v_done.credited_cents;
end $$;

revoke all on function private.founding_checkout_paid(uuid, text, text, integer, text, text) from public;
grant execute on function private.founding_checkout_paid(uuid, text, text, integer, text, text) to service_actor;

-- The worker deployed before this one: the same payment, with no card to keep.
create or replace function private.founding_checkout_paid(
  p_checkout uuid,
  p_session_ref text,
  p_payment_ref text,
  p_paid_cents integer
)
returns table (outcome text, grant_id uuid, offer_id text, plan app.plan_kind, credited_cents bigint)
language sql security definer set search_path = '' as $$
  select * from private.founding_checkout_paid(p_checkout, p_session_ref, p_payment_ref, p_paid_cents,
                                                null::text, null::text)
$$;

-- ---------- the page somebody comes back to ----------
/**
 * 0093's view of one checkout (`private.founding_checkout_view`), with three more facts: whether it pays a refused
 * renewal, how the seat is paid, and the date it is paid through. For a renewal, `seat_active` is the year having
 * moved on — the seat was on all along, so that is what the page waits for. The old function stays for the code
 * running before this; a later migration removes it.
 */
create or replace function private.founding_checkout_state(p_checkout uuid)
returns table (
  checkout_id uuid,
  workspace_id uuid,
  offer_name text,
  amount_cents integer,
  status text,
  session_url text,
  session_expires_at timestamptz,
  seat_active boolean,
  problem text,
  renewal boolean,
  billing text,
  paid_through timestamptz
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, o.name, c.amount_cents, c.status::text, c.session_url, c.session_expires_at,
         g.status = 'active' and g.workspace_id = c.workspace_id
           and (c.renewal_for is null or coalesce(p.current_period_end > c.renewal_for, false)),
         c.problem,
         c.renewal_for is not null,
         case when o.paid_yearly then 'yearly' else o.billing end,
         p.current_period_end
  from platform.founding_checkouts c
  join platform.founding_offers o on o.id = c.offer_id
  join platform.founding_grants g on g.id = c.grant_id
  left join app.workspace_plans p on p.workspace_id = c.workspace_id and p.grant_id = c.grant_id
  where c.id = p_checkout and private.has_permission(c.workspace_id, 'workspace.update')
$$;

revoke all on function private.founding_checkout_state(uuid) from public;
grant execute on function private.founding_checkout_state(uuid) to authenticated;

-- ---------- what a business may do about its year ----------
/**
 * Stop the seat renewing, or start it again. Only somebody who manages the business's money, on a seat that is
 * paid by the year and still theirs. Stopping keeps the seat until the year is up; starting again is only possible
 * while it is.
 */
create or replace function private.founding_set_renewing(p_workspace uuid, p_renewing boolean)
returns table (paid_through timestamptz, renewing boolean, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
begin
  if not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'Only somebody who manages money in workspace % can change its plan', p_workspace
      using errcode = '42501', detail = 'founding_renewal_not_yours';
  end if;

  select p.workspace_id, p.current_period_end, p.renewal_stopped_at into v_plan
  from app.workspace_plans p
  join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
  where p.workspace_id = p_workspace and p.current_period_end is not null
  for update of p;

  if v_plan.workspace_id is null then
    raise exception 'Workspace % has no founding seat paid by the year', p_workspace
      using errcode = '23514', detail = 'founding_not_yearly';
  end if;
  if p_renewing and v_plan.current_period_end <= now() then
    raise exception 'The year paid for in workspace % is already over', p_workspace
      using errcode = '23514', detail = 'founding_year_over';
  end if;

  if p_renewing = (v_plan.renewal_stopped_at is null) then
    return query select v_plan.current_period_end, p_renewing, false;
    return;
  end if;

  update app.workspace_plans
     set renewal_stopped_at = case when p_renewing then null else now() end,
         renewal_stopped_by = case when p_renewing then null else auth.uid() end
   where workspace_id = p_workspace;
  return query select v_plan.current_period_end, p_renewing, true;
end $$;

revoke all on function private.founding_set_renewing(uuid, boolean) from public;
grant execute on function private.founding_set_renewing(uuid, boolean) to authenticated;

/**
 * Pay a refused renewal with another card: a founding checkout for the year that is waiting, which the worker turns
 * into a Stripe page as it does any other. A second press picks up the one already under way.
 */
create or replace function private.founding_open_renewal_checkout(p_workspace uuid)
returns table (checkout_id uuid, status text, session_url text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
  v_live record;
  v_id uuid;
begin
  if not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'Only somebody who manages money in workspace % can pay for its plan', p_workspace
      using errcode = '42501', detail = 'founding_renewal_not_yours';
  end if;

  select p.workspace_id, p.organization_id, p.grant_id, p.price_cents, p.current_period_end, g.offer_id
    into v_plan
  from app.workspace_plans p
  join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
  where p.workspace_id = p_workspace and p.renewal_failed_at is not null and p.current_period_end is not null
  for update of p;

  if v_plan.workspace_id is null or v_plan.price_cents <= 0 then
    raise exception 'Workspace % has no renewal waiting to be paid', p_workspace
      using errcode = '23514', detail = 'founding_renewal_not_due';
  end if;

  select c.id, c.status, c.session_url, c.renewal_for into v_live
  from platform.founding_checkouts c
  where c.grant_id = v_plan.grant_id and c.status in ('pending', 'open');

  if v_live.id is not null then
    if v_live.renewal_for is distinct from v_plan.current_period_end then
      raise exception 'Workspace % already has a payment under way for its seat', p_workspace
        using errcode = '23514', detail = 'founding_checkout_elsewhere';
    end if;
    return query select v_live.id, v_live.status::text, v_live.session_url, false;
    return;
  end if;

  insert into platform.founding_checkouts
    (grant_id, offer_id, organization_id, workspace_id, amount_cents, requested_by, renewal_for)
  values
    (v_plan.grant_id, v_plan.offer_id, v_plan.organization_id, p_workspace, v_plan.price_cents, auth.uid(),
     v_plan.current_period_end)
  returning id into v_id;

  return query select v_id, 'pending'::text, null::text, true;
end $$;

revoke all on function private.founding_open_renewal_checkout(uuid) from public;
grant execute on function private.founding_open_renewal_checkout(uuid) to authenticated;

-- ---------- the worker's yearly sweep ----------
/**
 * Whose paid year is up and is to be charged: a seat still theirs, still renewing, not waiting on a refused card.
 * The sweep holds no business while it reads this, the way RCS's does (0104).
 */
create or replace function private.founding_renewals_due(p_limit integer)
returns table (grant_id uuid, workspace_id uuid, organization_id uuid, paid_through timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, p.workspace_id, p.organization_id, p.current_period_end
  from app.workspace_plans p
  join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
    and g.workspace_id = p.workspace_id
  where p.current_period_end is not null and p.current_period_end <= now()
    and p.renewal_stopped_at is null and p.renewal_failed_at is null
    and p.status = 'active' and p.price_cents > 0
  order by p.current_period_end
  limit greatest(1, least(p_limit, 500))
$$;

revoke all on function private.founding_renewals_due(integer) from public;
grant execute on function private.founding_renewals_due(integer) to service_actor;

/**
 * Seats somebody stopped renewing, whose year is up, go back: the grant is revoked with the reason written for
 * staff, the plan is `canceled`, and the seat is free for somebody else. Returns how many. Run hourly.
 */
create or replace function private.founding_end_stopped_years()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with ending as (
    select p.workspace_id, p.grant_id, p.current_period_end
    from app.workspace_plans p
    join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
    where p.current_period_end is not null and p.current_period_end <= now()
      and p.renewal_stopped_at is not null
    for update of p
  ), revoked as (
    update platform.founding_grants g
       set status = 'revoked', revoked_at = now(),
           revoke_reason = 'They stopped it renewing. It was paid through '
                           || to_char(e.current_period_end at time zone 'UTC', 'Mon FMDD, YYYY') || '.'
      from ending e
     where g.id = e.grant_id
    returning g.id
  ), canceled as (
    update app.workspace_plans p
       set status = 'canceled', canceled_at = now()
      from ending e
     where p.workspace_id = e.workspace_id
    returning p.workspace_id
  )
  select count(*) into v_count from revoked;
  return v_count;
end $$;

revoke all on function private.founding_end_stopped_years() from public;
grant execute on function private.founding_end_stopped_years() to service_actor;
