-- A free trial on every founding plan (the owner's ask of 2026-11-13: "add a 14 day free trial to my pricing").
--
-- Until now a free trial came only with a code (20261027014300). From here every plan paid by the month or the year
-- can carry one of its own, `founding_offers.trial_days`, and both plans on sale get 14 days. It is the code's trial,
-- made the default:
--
--   * The plan page's Stripe page keeps the card and charges nothing. The spot turns on at once, its first month or
--     year starts when the trial ends, and the hourly sweep charges the card then, as it does every renewal.
--     Stopping it renewing during the trial gives the spot back when the trial ends (20261027014300, unchanged).
--   * **One free trial a person, and a business.** Somebody who has started a founding plan before (a trial or a
--     payment, on any business), or a business that has, pays from the first day. A code's own trial still applies:
--     it is a promise somebody made them on purpose.
--   * **A code's trial and the plan's don't add up:** the longer one wins. A code's discount still comes off every
--     payment after the trial, for its months.
--   * `platform.founding_counts` carries each plan's trial beside its price; the website says it in its own words, as
--     it does the prices (`freeTrial` in apps/site/src/content/site.ts). The plan page asks `private.founding_trials`
--     what this person gets.
--
-- Nothing here touches a plan already running: the trial is decided when the spot is bought.

-- ---------- the trial a plan carries ----------
alter table platform.founding_offers
  -- Days free before the first charge, for a plan paid by the month or the year. Null: none.
  add column trial_days integer check (trial_days between 1 and 90);

comment on column platform.founding_offers.trial_days is
  'Days free before the first charge, for a plan paid by the month or the year (20261027027000). Null: no trial.';

update platform.founding_offers set trial_days = 14 where id in ('monthly', 'founding_lifetime');

-- ---------- who gets it ----------
/**
 * The free trial this person gets on a plan for this business before any code: the plan's own, when it is paid by the
 * month or the year and neither they nor the business have started a founding plan before. Null otherwise.
 */
create or replace function private.founding_trial_days(p_offer text, p_org uuid)
returns integer
language sql stable security definer set search_path = '' as $$
  select o.trial_days
  from platform.founding_offers o
  where o.id = p_offer and o.trial_days is not null and o.price_cents > 0
    and private.founding_period(o.id) is not null
    and not exists (
      select 1 from platform.founding_checkouts c
      where c.status = 'paid'
        and (c.organization_id = p_org or (auth.uid() is not null and c.requested_by = auth.uid())))
$$;

-- Only `private.founding_buy`, `private.affiliate_code_preview` and `private.founding_trials` call it, as its owner.
revoke all on function private.founding_trial_days(text, uuid) from public;

/** Each plan on sale, and the free trial this person gets on it for the business: the plan page, before any code. */
create or replace function private.founding_trials(p_workspace uuid)
returns table (offer_id text, trial_days integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.workspace_organization(p_workspace);
begin
  if v_org is null or not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'Only somebody who manages money in workspace % can buy its spot', p_workspace
      using errcode = '42501', detail = 'founding_buy_not_yours';
  end if;
  return query
    select o.id, private.founding_trial_days(o.id, v_org)
    from platform.founding_offers o
    where o.status <> 'draft' and o.price_cents > 0
    order by o.sort, o.id;
end $$;

revoke all on function private.founding_trials(uuid) from public;
grant execute on function private.founding_trials(uuid) to authenticated;

-- ---------- what the website reads ----------
-- 20261027009500's view, with each plan's trial at the end. Same columns before it, same order.
create or replace view platform.founding_counts as
  select o.id, o.name, o.blurb, o.status, o.price_cents, o.seat_cap,
         private.founding_seats_held(o.id) as claimed,
         greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining,
         o.sort,
         case when o.paid_yearly then 'yearly' else o.billing end as billing,
         o.show_counter,
         exists (select 1 from platform.founding_offers n
                  where n.opens_after_offer_id = o.id and n.status <> 'draft' and n.billing = 'once')
           as superseded,
         case when private.founding_period(o.id) is not null and o.price_cents > 0 then o.trial_days end
           as trial_days
  from platform.founding_offers o
  where o.status <> 'draft';

-- ---------- what a code takes off, with the plan's own trial ----------
/** 20261027014300's preview, saying the trial they'd really get: the code's or the plan's, whichever is longer. */
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
                          v_terms.discount_months,
                          greatest(v_terms.trial_days, private.founding_trial_days(v_offer.id, v_org));
    exception when check_violation then
      get stacked diagnostics v_detail = pg_exception_detail;
      return query select v_offer.id, v_detail, lower(btrim(p_code)), v_offer.price_cents, 0, null::integer,
                          null::integer;
    end;
  end loop;
end $$;

revoke all on function private.affiliate_code_preview(text, uuid) from public;
grant execute on function private.affiliate_code_preview(text, uuid) to authenticated;

-- ---------- buying a spot, with the plan's own trial ----------
/**
 * 20261027014300's `private.founding_buy`, giving the plan's own free trial when this person and the business haven't
 * had one (`private.founding_trial_days`): the page only keeps the card, as a code's trial does. With a code that has
 * a trial too, the longer one wins.
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
  -- The plan's own trial, when they haven't had one; the longer one wins over a code's.
  v_trial := greatest(v_trial, private.founding_trial_days(p_offer, v_org));
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
    -- Another code, or none now, or a trial it didn't have: that page stops being one, and this one is made.
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
