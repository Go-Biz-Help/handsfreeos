-- =============================================================================
-- Affiliates, part 3 (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md): codes.
--
--        Affiliates make their own codes (decision 11): a percent or dollar
--        discount, for some months or for good, a free trial of 7, 14 or 30
--        days (decision 16), or a trial then a discount (decision 18). Staff
--        make house codes that belong to nobody, and turn any code off
--        (decision 19). The plan page takes a code; each code has its own
--        link that fills it in (decision 20).
--
--        **The limit.** No code takes off more than 50% (decision 19), a
--        limit staff change for everyone (`affiliate_settings`) or for one
--        affiliate (`affiliates.max_discount_bp`). It is checked when a code
--        is made and again when it's used, so lowering it counts at once. A
--        house code goes up to 90%. Nothing goes past 90%, so a charge is
--        never nothing.
--
--        **A code is never changed.** It's made, and turned off or on. What a
--        business bought with it is kept on its checkout and its plan, so
--        turning a code off, or lowering the limit, never changes what a
--        business that already used it pays.
--
--        **The discount is shared** (decision 15): the affiliate earns their
--        share of what's actually paid, which part 2 already does.
--
--        **A trial** takes the card on Stripe's page in its setup mode,
--        charging nothing, and turns the spot on, held (decision 17). The
--        hourly sweep charges the card when the trial ends, the way it
--        renews any month or year. Stopping it renewing before then gives the
--        spot back when the trial ends.
--
--        **A code credits the business** to its affiliate when it pays with
--        it, if nobody has it yet and it hasn't paid for a plan before, so a
--        code typed on the plan page earns the affiliate who made it. A
--        business already credited stays with its affiliate, as with links.
--        Nobody uses their own code.
--
-- Only adds columns, a table and functions, and replaces functions with the same
-- shape. PowerSync copies nothing again: no synced table changes.
-- =============================================================================

-- ---------- the limit ----------
alter table platform.affiliate_settings
  -- The most any affiliate's code takes off, in basis points: 5000 is 50% (decision 19).
  add column max_discount_bp integer not null default 5000 check (max_discount_bp between 100 and 9000);

alter table platform.affiliates
  -- Their own limit, or null for everyone's.
  add column max_discount_bp integer check (max_discount_bp is null or max_discount_bp between 100 and 9000);

-- ---------- the codes ----------
create table platform.affiliate_codes (
  id uuid primary key default gen_random_uuid(),
  -- Whose it is. Null for a house code, made by staff for HandsFreeOS's own promotions.
  affiliate_id uuid references platform.affiliates (id) on delete cascade,
  -- What's typed, kept lowercase; typed in any case. The same shape as a link code.
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$'),
  -- The plan it's for, or null for any plan.
  offer_id text references platform.founding_offers (id) on delete cascade,
  -- A percent off (basis points) or dollars off (cents), each payment, or neither for a trial alone.
  percent_off_bp integer check (percent_off_bp between 1 and 9000),
  amount_off_cents integer check (amount_off_cents between 1 and 1000000),
  -- How many months the discount lasts, counted from the first payment; null for good.
  discount_months integer check (discount_months between 1 and 36),
  trial_days integer check (trial_days in (7, 14, 30)),
  status text not null default 'on' check (status in ('on', 'off')),
  -- Staff turned it off: only staff turn it back on.
  off_by_staff boolean not null default false,
  -- Businesses that bought their plan with it.
  paid_uses integer not null default 0 check (paid_uses >= 0),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (percent_off_bp is null or amount_off_cents is null),
  check (percent_off_bp is not null or amount_off_cents is not null or trial_days is not null),
  check (discount_months is null or percent_off_bp is not null or amount_off_cents is not null)
);
create trigger affiliate_codes_updated_at before update on platform.affiliate_codes
  for each row execute function private.set_updated_at();
create index affiliate_codes_affiliate on platform.affiliate_codes (affiliate_id, created_at desc);

alter table platform.affiliate_codes enable row level security;
create policy affiliate_codes_own on platform.affiliate_codes for select to authenticated
  using (exists (select 1 from platform.affiliates a
                 where a.id = affiliate_id and a.user_id = auth.uid()));
create policy affiliate_codes_staff on platform.affiliate_codes for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy affiliate_codes_service on platform.affiliate_codes for all to service_actor
  using (true) with check (true);
grant select on platform.affiliate_codes to authenticated;
grant select, insert, update on platform.affiliate_codes to service_actor;
revoke all on platform.affiliate_codes from anon;

-- ---------- what a checkout and a plan were bought with ----------
alter table platform.founding_checkouts
  add column code_id uuid references platform.affiliate_codes (id) on delete set null,
  -- The plan's price before the code. Null when no code was used: then `amount_cents` is the price.
  add column full_cents integer check (full_cents is null or full_cents > 0),
  -- Taken off each payment while the discount lasts.
  add column discount_cents integer not null default 0 check (discount_cents >= 0),
  -- How long the discount lasts; null for good (with a discount).
  add column discount_months integer check (discount_months between 1 and 36),
  -- A trial: nothing is charged on this page, which only keeps the card. `amount_cents` is the first charge.
  add column trial_days integer check (trial_days in (7, 14, 30));

alter table app.workspace_plans
  -- The code its spot was bought with, and what that takes off: `price_cents` stays the full price.
  add column code_id uuid references platform.affiliate_codes (id) on delete set null,
  add column discount_cents integer not null default 0 check (discount_cents >= 0),
  -- A month or year starting before this is discounted; null for good.
  add column discount_until timestamptz,
  -- When a free trial ends and its first charge is due. Null without one.
  add column trial_ends_at timestamptz;

-- ---------- what a code takes off ----------
/**
 * What a code takes off a plan, for the business about to buy it: its price, what comes off each payment, for how
 * many months, and any trial. Refuses, by `detail`, a code that isn't one or is off (`affiliate_code_unknown`), one
 * for the other plan or a trial on a plan paid once (`affiliate_code_other_plan`), and one the business's own
 * affiliate made (`affiliate_code_own`). The discount is held to the limit as it stands now.
 */
create or replace function private.affiliate_code_terms(p_code text, p_offer text, p_org uuid)
returns table (
  code_id uuid,
  affiliate_id uuid,
  code text,
  full_cents integer,
  discount_cents integer,
  discount_months integer,
  trial_days integer
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v record;
  v_price integer;
  v_cap integer;
  v_off integer := 0;
begin
  select c.id, c.affiliate_id, c.code, c.offer_id, c.percent_off_bp, c.amount_off_cents, c.discount_months,
         c.trial_days, c.status, a.status as affiliate_status, a.user_id as affiliate_user,
         coalesce(a.max_discount_bp, s.max_discount_bp) as cap
    into v
  from platform.affiliate_codes c
  left join platform.affiliates a on a.id = c.affiliate_id
  cross join platform.affiliate_settings s
  where c.code = lower(btrim(p_code));

  if v.id is null or v.status <> 'on' or (v.affiliate_id is not null and v.affiliate_status <> 'approved') then
    raise exception 'There is no code %', p_code using errcode = '23514', detail = 'affiliate_code_unknown';
  end if;
  if (v.offer_id is not null and v.offer_id <> p_offer)
     or (v.trial_days is not null and private.founding_period(p_offer) is null) then
    raise exception 'Code % is for another plan', p_code
      using errcode = '23514', detail = 'affiliate_code_other_plan';
  end if;
  if v.affiliate_id is not null
     and (v.affiliate_user = auth.uid()
          or exists (select 1 from app.organizations o where o.id = p_org and o.created_by = v.affiliate_user)) then
    raise exception 'Code % is the business''s own affiliate''s', p_code
      using errcode = '23514', detail = 'affiliate_code_own';
  end if;

  select o.price_cents into v_price from platform.founding_offers o where o.id = p_offer;
  v_cap := case when v.affiliate_id is null then 9000 else least(v.cap, 9000) end;
  if v.percent_off_bp is not null then
    v_off := round(v_price * least(v.percent_off_bp, v_cap) / 10000.0)::integer;
  elsif v.amount_off_cents is not null then
    v_off := least(v.amount_off_cents, floor(v_price * v_cap / 10000.0)::integer);
  end if;

  return query select v.id, v.affiliate_id, v.code, v_price, v_off,
                      case when v_off > 0 then v.discount_months end, v.trial_days;
end $$;

-- Only `private.founding_buy` and `private.affiliate_code_preview` call it, as its owner: nobody reads a code's
-- affiliate through it.
revoke all on function private.affiliate_code_terms(text, text, uuid) from public;

/**
 * What a code takes off each plan on sale, for the plan page before Pay: one row an offer, with why it doesn't apply
 * (`refusal`, `private.affiliate_code_terms`'s `detail`) when it doesn't. Only for whoever may buy the business's spot.
 */
create or replace function private.affiliate_code_preview(p_code text, p_workspace uuid)
returns table (
  offer_id text,
  refusal text,
  code text,
  full_cents integer,
  discount_cents integer,
  discount_months integer,
  trial_days integer
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.workspace_organization(p_workspace);
  v_offer record;
  v_terms record;
  v_detail text;
begin
  if v_org is null or not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'Only somebody who manages money in workspace % can buy its spot', p_workspace
      using errcode = '42501', detail = 'founding_buy_not_yours';
  end if;
  for v_offer in
    select o.id, o.price_cents from platform.founding_offers o
    where o.status <> 'draft' and o.price_cents > 0 order by o.sort, o.id
  loop
    begin
      select * into v_terms from private.affiliate_code_terms(p_code, v_offer.id, v_org);
      return query select v_offer.id, null::text, v_terms.code, v_terms.full_cents, v_terms.discount_cents,
                          v_terms.discount_months, v_terms.trial_days;
    exception when check_violation then
      get stacked diagnostics v_detail = pg_exception_detail;
      return query select v_offer.id, v_detail, lower(btrim(p_code)), v_offer.price_cents, 0, null::integer,
                          null::integer;
    end;
  end loop;
end $$;

revoke all on function private.affiliate_code_preview(text, uuid) from public;
grant execute on function private.affiliate_code_preview(text, uuid) to authenticated;

-- ---------- making a code, and turning it off ----------
/**
 * Make a code: an affiliate their own, while approved, or staff one for any affiliate or a house code (no affiliate).
 * Refuses, by `detail`: `affiliate_code_not_yours`, `affiliate_not_approved`, `affiliate_code_too_many` (20 on at a
 * time each), `affiliate_code_no_plan` (a plan not for sale), `affiliate_code_over_limit` (more off than the limit,
 * which for dollars is the limit of the cheapest plan it's for) and `affiliate_code_taken`.
 */
create or replace function private.affiliate_make_code(
  p_affiliate uuid,
  p_code text,
  p_offer text,
  p_percent_bp integer,
  p_amount_cents integer,
  p_months integer,
  p_trial integer
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_staff boolean := private.staff_can('platform.affiliates.manage');
  v_aff record;
  v_cap integer := 9000;
  v_price integer;
  v_code text := lower(btrim(p_code));
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if p_affiliate is null then
    if not v_staff then
      raise exception 'Only staff make house codes' using errcode = '42501', detail = 'affiliate_code_not_yours';
    end if;
  else
    select a.id, a.user_id, a.status, coalesce(a.max_discount_bp, s.max_discount_bp) as cap into v_aff
    from platform.affiliates a cross join platform.affiliate_settings s
    where a.id = p_affiliate
    for update of a;
    if v_aff.id is null or (v_aff.user_id <> v_uid and not v_staff) then
      raise exception 'Not your affiliate row' using errcode = '42501', detail = 'affiliate_code_not_yours';
    end if;
    if v_aff.status <> 'approved' then
      raise exception 'Affiliate % is not approved', p_affiliate
        using errcode = '23514', detail = 'affiliate_not_approved';
    end if;
    v_cap := least(v_aff.cap, 9000);
    if (select count(*) from platform.affiliate_codes c
        where c.affiliate_id = p_affiliate and c.status = 'on') >= 20 then
      raise exception 'Twenty codes on already' using errcode = '23514', detail = 'affiliate_code_too_many';
    end if;
  end if;

  select min(o.price_cents) into v_price from platform.founding_offers o
  where o.price_cents > 0 and o.status <> 'draft' and (p_offer is null or o.id = p_offer)
    and (p_trial is null or private.founding_period(o.id) is not null);
  if v_price is null then
    raise exception 'No plan for sale for this code' using errcode = '23514', detail = 'affiliate_code_no_plan';
  end if;
  if coalesce(p_percent_bp, 0) > v_cap or coalesce(p_amount_cents, 0) > floor(v_price * v_cap / 10000.0) then
    raise exception 'More off than % basis points', v_cap
      using errcode = '23514', detail = 'affiliate_code_over_limit';
  end if;
  if exists (select 1 from platform.affiliate_codes c where c.code = v_code) then
    raise exception 'That code is taken' using errcode = '23505', detail = 'affiliate_code_taken';
  end if;

  insert into platform.affiliate_codes
    (affiliate_id, code, offer_id, percent_off_bp, amount_off_cents, discount_months, trial_days, created_by)
  values (p_affiliate, v_code, p_offer, p_percent_bp, p_amount_cents,
          case when p_percent_bp is not null or p_amount_cents is not null then p_months end, p_trial, v_uid)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function private.affiliate_make_code(uuid, text, text, integer, integer, integer, integer) from public;
grant execute on function private.affiliate_make_code(uuid, text, text, integer, integer, integer, integer)
  to authenticated;

/**
 * Turn a code off or on. An affiliate turns their own; staff turn any, and a code staff turned off only staff turn
 * back on. Answers whether anything changed. Refuses `affiliate_code_missing`, `affiliate_code_not_yours`,
 * `affiliate_code_off_by_staff` and, turning one on, `affiliate_not_approved`.
 */
create or replace function private.affiliate_turn_code(p_code uuid, p_on boolean)
returns table (code_id uuid, affiliate_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v record;
  v_as_staff boolean;
begin
  select c.id, c.affiliate_id, c.status, c.off_by_staff, a.user_id as affiliate_user,
         a.status as affiliate_status
    into v
  from platform.affiliate_codes c left join platform.affiliates a on a.id = c.affiliate_id
  where c.id = p_code
  for update of c;
  if v.id is null then
    raise exception 'There is no code %', p_code using errcode = '23503', detail = 'affiliate_code_missing';
  end if;
  v_as_staff := private.staff_can('platform.affiliates.manage')
                and v.affiliate_user is distinct from v_uid;
  if not v_as_staff and (v_uid is null or v.affiliate_user is distinct from v_uid) then
    raise exception 'Not your code' using errcode = '42501', detail = 'affiliate_code_not_yours';
  end if;
  if p_on and v.affiliate_id is not null and v.affiliate_status <> 'approved' then
    raise exception 'Affiliate is not approved' using errcode = '23514', detail = 'affiliate_not_approved';
  end if;
  if p_on and not v_as_staff and v.off_by_staff then
    raise exception 'Staff turned it off' using errcode = '23514', detail = 'affiliate_code_off_by_staff';
  end if;
  if (v.status = 'on') = p_on then
    return query select v.id, v.affiliate_id, false;
    return;
  end if;
  update platform.affiliate_codes c
     set status = case when p_on then 'on' else 'off' end,
         off_by_staff = case when v_as_staff then not p_on else c.off_by_staff end
   where c.id = v.id;
  return query select v.id, v.affiliate_id, true;
end $$;

revoke all on function private.affiliate_turn_code(uuid, boolean) from public;
grant execute on function private.affiliate_turn_code(uuid, boolean) to authenticated;

-- ---------- what the next charge is ----------
/**
 * What the plan charges for the month or year starting at its `current_period_end`: its price, less its code's
 * discount while that lasts.
 */
create or replace function private.founding_charge_cents(p_workspace uuid)
returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(p.price_cents
                  - case when p.discount_cents > 0
                          and (p.discount_until is null or p.current_period_end < p.discount_until)
                         then p.discount_cents else 0 end, 0)
  from app.workspace_plans p where p.workspace_id = p_workspace
$$;

revoke all on function private.founding_charge_cents(uuid) from public;
grant execute on function private.founding_charge_cents(uuid) to service_actor;

-- ---------- taking a spot up ----------
/** 20261027012700's activation, which also clears what a code took off a spot the business had before. */
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
        renewal_failed_at = null, code_id = null, discount_cents = 0, discount_until = null,
        trial_ends_at = null;

  select c.credited_cents into v_credited from private.founding_credit_wallet(p_grant) c;

  return query select v_plan, coalesce(v_credited, 0::bigint);
end $$;

revoke all on function private.founding_activate(uuid, uuid) from public;

-- ---------- the money is in, or the card is kept for a trial ----------
/**
 * 20261027012700's payment, with codes. A page bought with a code keeps the plan's full price and what the code
 * takes off, and how long, on the plan; the next charges come off it. A trial's page charged nothing and kept the
 * card: the spot turns on, and its first charge is due when the trial ends. Everything else is unchanged.
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
  v_first timestamptz;
begin
  select c.id, c.status, c.grant_id, c.offer_id, c.organization_id, c.workspace_id, c.amount_cents,
         c.renewal_for, c.code_id, c.full_cents, c.discount_cents, c.discount_months, c.trial_days into v_c
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

  -- A trial's page charges nothing: it only has to have kept a card.
  if (v_c.trial_days is null and coalesce(p_paid_cents, 0) < v_c.amount_cents)
     or (v_c.trial_days is not null and p_card_ref is null) then
    update platform.founding_checkouts
       set problem = case when v_c.trial_days is null
                       then format('Stripe says %s cents were paid; the spot costs %s. The spot was not turned on.',
                                   coalesce(p_paid_cents, 0), v_c.amount_cents)
                       else 'Stripe kept no card for the trial. The spot was not turned on.' end
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

  -- A spot paid by the month or the year carries its period, its price, its code and its card from the first
  -- payment. With a trial, the first month or year starts when the trial ends, and is charged then.
  if v_period is not null then
    v_first := now() + coalesce(make_interval(days => v_c.trial_days), interval '0');
    update app.workspace_plans
       set price_cents = coalesce(v_c.full_cents, v_c.amount_cents),
           current_period_end = case when v_c.trial_days is not null then v_first else now() + v_period end,
           code_id = v_c.code_id,
           discount_cents = v_c.discount_cents,
           discount_until = case when v_c.discount_cents > 0 and v_c.discount_months is not null
                                 then v_first + make_interval(months => v_c.discount_months) end,
           trial_ends_at = case when v_c.trial_days is not null then v_first end,
           stripe_customer_id = p_customer_ref, stripe_card_id = p_card_ref,
           renewal_count = 0, renewal_problem = null, renewal_failed_at = null,
           renewal_stopped_at = null, renewal_stopped_by = null
     where workspace_id = v_c.workspace_id;
  end if;

  -- What the code was used for, and the business is its affiliate's when nobody has it yet and it hasn't paid for a
  -- plan before. Its first payment is kept after this, in the same transaction, and earns them their share.
  if v_c.code_id is not null then
    update platform.affiliate_codes set paid_uses = paid_uses + 1 where id = v_c.code_id;
    insert into platform.affiliate_referrals (organization_id, affiliate_id, how)
    select v_c.organization_id, c.affiliate_id, 'code'
    from platform.affiliate_codes c
    join platform.affiliates a on a.id = c.affiliate_id and a.status = 'approved'
    where c.id = v_c.code_id
      and not exists (select 1 from platform.plan_payments pp where pp.organization_id = v_c.organization_id)
    on conflict (organization_id) do nothing;
  end if;

  return query select 'activated'::text, v_c.grant_id, v_c.offer_id, v_done.plan, v_done.credited_cents;
end $$;

revoke all on function private.founding_checkout_paid(uuid, text, text, integer, text, text) from public;
grant execute on function private.founding_checkout_paid(uuid, text, text, integer, text, text) to service_actor;

-- ---------- buying a spot, with a code ----------
/**
 * 20261027012700's `private.founding_buy`, taking a code. A code that isn't one refuses (`private.affiliate_code_terms`
 * says why); one that is takes its discount off the page's price, or makes the page a trial that only keeps the card.
 * A payment already under way for another code, or none, stops being one and a new page is made. The business is
 * credited to the code's affiliate when it pays (`private.founding_checkout_paid`), not here.
 */
create or replace function private.founding_buy(p_workspace uuid, p_offer text, p_code text)
returns table (checkout_id uuid, grant_id uuid, status text, session_url text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.workspace_organization(p_workspace);
  v_offer record;
  v_live record;
  v_grant uuid;
  v_page record;
  v_id uuid;
  v_code_id uuid;
  v_off integer := 0;
  v_months integer;
  v_trial integer;
  v_amount integer;
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

  if nullif(btrim(coalesce(p_code, '')), '') is not null then
    select t.code_id, t.discount_cents, t.discount_months, t.trial_days
      into v_code_id, v_off, v_months, v_trial
    from private.affiliate_code_terms(p_code, p_offer, v_org) t;
  end if;
  v_amount := v_offer.price_cents - coalesce(v_off, 0);

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

  select c.id, c.workspace_id, c.status, c.session_url, c.code_id, c.amount_cents, c.trial_days into v_page
  from platform.founding_checkouts c
  where c.grant_id = v_grant and c.status in ('pending', 'open');

  if v_page.id is not null then
    if v_page.workspace_id <> p_workspace then
      raise exception 'Spot % is already being paid for on workspace %', v_grant, v_page.workspace_id
        using errcode = '23514', detail = 'founding_checkout_elsewhere';
    end if;
    if v_page.code_id is not distinct from v_code_id and v_page.amount_cents = v_amount
       and v_page.trial_days is not distinct from v_trial then
      return query select v_page.id, v_grant, v_page.status::text, v_page.session_url, false;
      return;
    end if;
    -- Another code, or none now: that page stops being one, and this one is made.
    update platform.founding_checkouts c
       set status = 'failed', closed_at = now(), problem = 'They changed the code before paying.'
     where c.id = v_page.id;
  end if;

  insert into platform.founding_checkouts
    (grant_id, offer_id, organization_id, workspace_id, amount_cents, requested_by, code_id, full_cents,
     discount_cents, discount_months, trial_days)
  values
    (v_grant, p_offer, v_org, p_workspace, v_amount, auth.uid(), v_code_id,
     case when v_code_id is not null then v_offer.price_cents end, coalesce(v_off, 0), v_months, v_trial)
  returning id into v_id;

  return query select v_id, v_grant, 'pending'::text, null::text, true;
end $$;

revoke all on function private.founding_buy(uuid, text, text) from public;
grant execute on function private.founding_buy(uuid, text, text) to authenticated;

-- ---------- paying a refused renewal on a page of its own ----------
/** 20261027009500's renewal page, charging what the month or year costs with its code's discount. */
create or replace function private.founding_open_renewal_checkout(p_workspace uuid)
returns table (checkout_id uuid, status text, session_url text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
  v_live record;
  v_id uuid;
  v_amount integer;
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
  v_amount := private.founding_charge_cents(p_workspace);

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
    (v_plan.grant_id, v_plan.offer_id, v_plan.organization_id, p_workspace, v_amount, auth.uid(),
     v_plan.current_period_end)
  returning id into v_id;

  return query select v_id, 'pending'::text, null::text, true;
end $$;

revoke all on function private.founding_open_renewal_checkout(uuid) from public;
grant execute on function private.founding_open_renewal_checkout(uuid) to authenticated;
