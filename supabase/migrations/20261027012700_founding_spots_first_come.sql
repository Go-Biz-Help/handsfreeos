-- =============================================================================
-- Founding spots are first come, first served (the owner's call, 2026-10-27).
--
--        Nobody applies any more. A business signs up, picks a spot and pays
--        for it by card before it sets up: $497 a year (100 spots, the
--        `founding_lifetime` offer) or $97 a month (1,000 spots, the
--        `monthly` offer). Businesses that signed up before this are left as
--        they are.
--
--        **The $97 row becomes spots.** 0092 made `monthly` a plan with no
--        seats, never granted and never counted. It is a seat offer now,
--        exactly like the $497 one: capped at 1,000 under the same lock
--        (0091), counted on the website, paid at Stripe Checkout, and renewed
--        each month by the sweep that renews the yearly seat (20261027009500).
--        Its `billing` stays `monthly`, which is what the app and the website
--        already call it, so the API running before this keeps working. It no
--        longer waits on 25 $497 seats: it opens beside them, here, where they
--        are open (the hosted database). Where they are still a draft (a
--        local stack, CI) nothing opens, so nobody there is asked to pay.
--
--        **A business buys its own spot** (`private.founding_buy`, behind
--        `founding.buy`). The spot is held while it pays — the same
--        reservation an approval made, marked `self_serve` — but only for an
--        hour, because it waits on a card rather than on a person reading an
--        email. Picking the other plan before paying gives the first hold
--        back. If the first page is paid anyway, the money wins over the hold
--        that replaced it (`private.founding_checkout_paid`); a business that
--        pays twice keeps one spot and the second payment is flagged for a
--        refund, never refused.
--
--        **Who has to pay.** A business created while a paid spot is on sale
--        is marked `needs_plan`, and until it holds a plan the web sends it to
--        the plan page and the phone sends it to the web
--        (`private.workspace_needs_plan`, read by `account.me`). Every
--        business that exists now stays unmarked, and nothing about them
--        changes. A spot staff give still lets a business in for free.
--
--        Only adds and replaces functions with the same shape; no table loses
--        anything, so the code running now keeps working. PowerSync copies
--        nothing again: no synced table changes.
-- =============================================================================

-- ---------- a spot bought, not given ----------
alter table platform.founding_grants
  /**
   * The business took this spot itself, from the plan page (`founding.buy`), rather than staff approving or giving
   * it. Held for an hour while the card is paid; another plan picked before paying gives it back.
   */
  add column self_serve boolean not null default false;

-- ---------- the $97 spots ----------
/**
 * 0092's cap, without its one refusal: the monthly offer has spots now, like every other. The lock on the offer's
 * row, the count, and no system-actor bypass are unchanged.
 */
create or replace function private.guard_founding_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cap integer;
  v_status platform.founding_offer_status;
  v_held integer;
  v_was_held boolean := tg_op = 'UPDATE' and old.status in ('reserved', 'active');
begin
  if new.status not in ('reserved', 'active') or v_was_held then
    return new;
  end if;

  select o.seat_cap, o.status into v_cap, v_status
  from platform.founding_offers o where o.id = new.offer_id for update;

  if v_cap is null then
    raise exception 'There is no offer called %', new.offer_id
      using errcode = '23503', detail = 'founding_offer_missing';
  end if;
  if v_status <> 'open' then
    raise exception 'The % offer is not taking anybody new', new.offer_id
      using errcode = '23514', detail = 'founding_offer_closed';
  end if;

  v_held := private.founding_seats_held(new.offer_id);
  if v_held >= v_cap then
    raise exception 'Every spot in % is taken (% of %)', new.offer_id, v_held, v_cap
      using errcode = '23514', detail = 'founding_offer_full';
  end if;
  return new;
end $$;

-- 1,000 spots with a counter, opened by nobody but the line below. The cap can only go down to what is held, and
-- nobody holds one yet.
update platform.founding_offers
   set seat_cap = 1000,
       show_counter = true,
       opens_after_offer_id = null,
       opens_after_count = null,
       name = 'Founding Monthly',
       blurb = '$97 a month, for one business. Texts, calls and AI are billed for what you use.'
 where id = 'monthly';

update platform.founding_offers
   set status = 'open'
 where id = 'monthly' and status = 'draft'
   and exists (select 1 from platform.founding_offers o where o.id = 'founding_lifetime' and o.status = 'open');

/** How long one payment pays for: a month, a year, or nothing more to pay (a seat paid once, or free). */
create or replace function private.founding_period(p_offer text)
returns interval
language sql stable security definer set search_path = '' as $$
  select case when o.billing = 'monthly' then interval '1 month'
              when o.paid_yearly then interval '1 year' end
  from platform.founding_offers o where o.id = p_offer
$$;

revoke all on function private.founding_period(text) from public;
grant execute on function private.founding_period(text) to authenticated, service_actor;

-- ---------- taking a spot up ----------
/**
 * 20261027009500's activation, with the plan named for how the spot is paid: a monthly spot is the `monthly` plan.
 * Everything else is unchanged.
 */
create or replace function private.founding_activate(p_grant uuid, p_workspace uuid)
returns table (plan app.plan_kind, credited_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_price integer;
  v_billing text;
  v_plan app.plan_kind;
  v_credited bigint;
begin
  select g.organization_id, o.price_cents, o.billing into v_org, v_price, v_billing
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

  v_plan := case when v_price = 0 then 'founding_free'::app.plan_kind
                 when v_billing = 'monthly' then 'monthly'::app.plan_kind
                 else 'founding_lifetime'::app.plan_kind end;

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
 * 20261027009500's payment, for a spot paid by the month as well as by the year (`private.founding_period`), and for
 * a business that bought its own spot.
 *
 * A spot the business bought itself wins over any other hold it has that nobody paid for: it picked the other plan,
 * then paid on the first page anyway. That hold goes back and its page stops being one. A business that already has
 * a spot (it paid on two pages) keeps it, and this payment is `no_seat`, written down for staff to refund.
 *
 * `outcome` is `activated`, `renewed`, `already` or `no_seat`, as before.
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
  v_period interval;
  v_self_serve boolean;
  v_done record;
  v_plan record;
begin
  select c.id, c.status, c.grant_id, c.offer_id, c.organization_id, c.workspace_id, c.amount_cents,
         c.renewal_for into v_c
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
       set problem = format('Stripe says %s cents were paid; the spot costs %s. The spot was not turned on.',
                            coalesce(p_paid_cents, 0), v_c.amount_cents)
     where id = p_checkout;
    return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end if;

  v_period := private.founding_period(v_c.offer_id);

  -- A refused renewal, paid with another card: the month or year it was made for moves on, if it is still that one.
  if v_c.renewal_for is not null then
    select p.workspace_id, p.plan, p.current_period_end into v_plan
    from app.workspace_plans p
    join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
    where p.workspace_id = v_c.workspace_id and p.grant_id = v_c.grant_id
    for update of p;
    if v_plan.workspace_id is null or v_plan.current_period_end is distinct from v_c.renewal_for then
      update platform.founding_checkouts
         set problem = case when v_plan.workspace_id is null
                         then 'Paid a renewal, but the spot was taken back first. Refund it, or put the spot back.'
                         else 'Paid a renewal that was already paid. Refund it.' end
       where id = p_checkout;
      return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
      return;
    end if;
    update app.workspace_plans
       set current_period_end = v_c.renewal_for + coalesce(v_period, interval '1 year'),
           renewal_count = renewal_count + 1, renewal_problem = null, renewal_failed_at = null,
           status = 'active',
           stripe_customer_id = coalesce(p_customer_ref, stripe_customer_id),
           stripe_card_id = coalesce(p_card_ref, stripe_card_id)
     where workspace_id = v_c.workspace_id;
    return query select 'renewed'::text, v_c.grant_id, v_c.offer_id, v_plan.plan, 0::bigint;
    return;
  end if;

  -- Money in beats a hold: the business's other self-serve hold, unpaid, goes back with its page.
  select g.self_serve into v_self_serve from platform.founding_grants g where g.id = v_c.grant_id;
  if v_self_serve then
    with dropped as (
      update platform.founding_grants g
         set status = 'expired'
       where g.organization_id = v_c.organization_id and g.id <> v_c.grant_id
         and g.status = 'reserved' and g.self_serve
         and not exists (select 1 from platform.founding_checkouts p
                          where p.grant_id = g.id and p.status = 'paid')
      returning g.id)
    update platform.founding_checkouts c
       set status = 'failed', closed_at = now(), problem = 'They paid for the other plan instead.'
      from dropped d
     where c.grant_id = d.id and c.status in ('pending', 'open');
  end if;

  begin
    select * into v_done from private.founding_activate(v_c.grant_id, v_c.workspace_id);
  exception
    when check_violation then
      -- Revoked meanwhile (founding_claim_invalid), or lapsed and given away (founding_offer_full): as in 0093.
      update platform.founding_checkouts
         set problem = left('Paid, but the spot could not be turned on: ' || sqlerrm, 1000)
       where id = p_checkout;
      return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
      return;
    when unique_violation then
      -- The business already holds a spot: it paid on two pages. It keeps the one it has.
      update platform.founding_checkouts
         set problem = 'Paid, but this business already has a founding spot. Refund this payment.'
       where id = p_checkout;
      return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
      return;
  end;

  -- A spot paid by the month or the year carries its period, its price and its card from the first payment.
  if v_period is not null then
    update app.workspace_plans
       set price_cents = v_c.amount_cents,
           current_period_end = now() + v_period,
           stripe_customer_id = p_customer_ref, stripe_card_id = p_card_ref,
           renewal_count = 0, renewal_problem = null, renewal_failed_at = null,
           renewal_stopped_at = null, renewal_stopped_by = null
     where workspace_id = v_c.workspace_id;
  end if;

  return query select 'activated'::text, v_c.grant_id, v_c.offer_id, v_done.plan, v_done.credited_cents;
end $$;

revoke all on function private.founding_checkout_paid(uuid, text, text, integer, text, text) from public;
grant execute on function private.founding_checkout_paid(uuid, text, text, integer, text, text) to service_actor;

-- ---------- buying a spot ----------
/**
 * Hold a spot for this business and start paying for it, or pick up the payment already under way.
 *
 * Only somebody who manages the business's money, and only an open offer with a price: a free spot is never bought.
 * The insert is where the spot is taken, under the cap's lock (0091), so "every spot is taken" is a refusal from the
 * guard rather than a count read beforehand. The business's row is locked first, so two presses arrive one after the
 * other and the second picks up the first's payment.
 *
 * A business already holding a spot it bought for the other plan, unpaid, gives that one back: it changed its mind.
 * One holding a spot staff approved, or one it has already taken up, is refused.
 *
 * `created` is false when this picked up a payment already under way.
 */
create or replace function private.founding_buy(p_workspace uuid, p_offer text)
returns table (checkout_id uuid, grant_id uuid, status text, session_url text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.workspace_organization(p_workspace);
  v_offer record;
  v_live record;
  v_grant uuid;
  v_page record;
  v_id uuid;
begin
  if v_org is null or not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'Only somebody who manages money in workspace % can buy its spot', p_workspace
      using errcode = '42501', detail = 'founding_buy_not_yours';
  end if;

  select o.id, o.price_cents, o.status into v_offer
  from platform.founding_offers o where o.id = p_offer and o.status <> 'draft';
  if v_offer.id is null then
    raise exception 'There is no offer called %', p_offer
      using errcode = '23503', detail = 'founding_offer_missing';
  end if;
  if v_offer.price_cents <= 0 then
    raise exception 'The % offer is not for sale', p_offer
      using errcode = '23514', detail = 'founding_offer_not_for_sale';
  end if;

  perform 1 from app.organizations o where o.id = v_org for update;

  select g.id, g.offer_id, g.status, g.self_serve into v_live
  from platform.founding_grants g
  where g.organization_id = v_org and g.status in ('reserved', 'active');

  if v_live.id is not null and (v_live.status = 'active' or (v_live.offer_id <> p_offer and not v_live.self_serve))
  then
    raise exception 'Business % already holds a founding spot', v_org
      using errcode = '23514', detail = 'founding_org_has_a_seat';
  end if;

  if v_live.id is not null and v_live.offer_id <> p_offer then
    -- They picked the other plan before paying: the first hold goes back, and its page stops being one.
    update platform.founding_checkouts c
       set status = 'failed', closed_at = now(), problem = 'They picked the other plan instead.'
     where c.grant_id = v_live.id and c.status in ('pending', 'open');
    update platform.founding_grants g set status = 'expired' where g.id = v_live.id;
  else
    v_grant := v_live.id;
  end if;

  if v_grant is null then
    insert into platform.founding_grants (offer_id, organization_id, status, expires_at, self_serve)
    values (p_offer, v_org, 'reserved', now() + interval '1 hour', true)
    returning id into v_grant;
  else
    update platform.founding_grants g
       set expires_at = greatest(g.expires_at, now() + interval '1 hour')
     where g.id = v_grant;
  end if;

  select c.id, c.workspace_id, c.status, c.session_url into v_page
  from platform.founding_checkouts c
  where c.grant_id = v_grant and c.status in ('pending', 'open');

  if v_page.id is not null then
    if v_page.workspace_id <> p_workspace then
      raise exception 'Spot % is already being paid for on workspace %', v_grant, v_page.workspace_id
        using errcode = '23514', detail = 'founding_checkout_elsewhere';
    end if;
    return query select v_page.id, v_grant, v_page.status::text, v_page.session_url, false;
    return;
  end if;

  insert into platform.founding_checkouts
    (grant_id, offer_id, organization_id, workspace_id, amount_cents, requested_by)
  values
    (v_grant, p_offer, v_org, p_workspace, v_offer.price_cents, auth.uid())
  returning id into v_id;

  return query select v_id, v_grant, 'pending'::text, null::text, true;
end $$;

revoke all on function private.founding_buy(uuid, text) from public;
grant execute on function private.founding_buy(uuid, text) to authenticated;

-- ---------- the page somebody comes back to ----------
/**
 * 20261027009500's `private.founding_checkout_state`, saying at the end whether the business bought the spot itself:
 * then the page sends it on to set up, or back to pick a plan, rather than to a claim link it never had. A new name
 * rather than a new shape, so nothing is dropped: the code running before this keeps calling the old one, which a
 * later migration removes.
 */
create function private.founding_checkout_status(p_checkout uuid)
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
  paid_through timestamptz,
  self_serve boolean
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, o.name, c.amount_cents, c.status::text, c.session_url, c.session_expires_at,
         g.status = 'active' and g.workspace_id = c.workspace_id
           and (c.renewal_for is null or coalesce(p.current_period_end > c.renewal_for, false)),
         c.problem,
         c.renewal_for is not null,
         case when o.paid_yearly then 'yearly' else o.billing end,
         p.current_period_end,
         g.self_serve
  from platform.founding_checkouts c
  join platform.founding_offers o on o.id = c.offer_id
  join platform.founding_grants g on g.id = c.grant_id
  left join app.workspace_plans p on p.workspace_id = c.workspace_id and p.grant_id = c.grant_id
  where c.id = p_checkout and private.has_permission(c.workspace_id, 'workspace.update')
$$;

revoke all on function private.founding_checkout_status(uuid) from public;
grant execute on function private.founding_checkout_status(uuid) to authenticated;

-- ---------- who has to pay ----------
alter table app.organizations
  /**
   * Created while a paid founding spot was on sale: the business holds a plan before it uses HandsFreeOS. Set when the
   * business is made, never by the business itself. Every business made before 2026-10-27 is false.
   */
  add column needs_plan boolean not null default false;

create or replace function private.organization_needs_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.needs_plan := new.needs_plan or exists (
    select 1 from platform.founding_offers o where o.status = 'open' and o.price_cents > 0);
  return new;
end $$;

create trigger organizations_needs_plan before insert on app.organizations
  for each row execute function private.organization_needs_plan();

-- A business's own update may not touch it: the twin of private.guard_is_platform().
create or replace function private.guard_needs_plan()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.needs_plan is distinct from old.needs_plan then
    raise exception 'Only HandsFreeOS decides whether a business has to pay first'
      using errcode = '42501', detail = 'needs_plan_is_ours';
  end if;
  return new;
end $$;

create trigger organizations_guard_needs_plan before update on app.organizations
  for each row execute function private.guard_needs_plan();

/**
 * Whether this workspace's business still has to pick a plan and pay before it uses HandsFreeOS: it was made while a
 * paid spot was on sale, and none of its workspaces has a plan that is on (active, in its notice, or past due on a
 * refused card). A spot that ended (stopped renewing) asks again. Anybody may ask about any workspace; the answer is
 * one yes or no.
 */
create or replace function private.workspace_needs_plan(p_ws uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select o.needs_plan and not exists (
             select 1 from app.workspace_plans p
              where p.organization_id = o.id and p.status in ('active', 'grace', 'past_due'))
    from app.workspaces w
    join app.organizations o on o.id = w.organization_id
    where w.id = p_ws), false)
$$;

revoke all on function private.workspace_needs_plan(uuid) from public;
grant execute on function private.workspace_needs_plan(uuid) to authenticated, service_actor;
