-- =============================================================================
-- Billing for a founding plan: several cards, daily retries, a new payment day, and asking for more time.
--
--        **The owner's call (2026-11-08):** a business adds cards whenever it likes. One is the default and the
--        rest are backups, tried in turn when the default is declined. A declined renewal is tried again once a
--        day, at a random time. The business may move its payment day: later costs the days it adds, paid now;
--        earlier takes the days it gives up off the next payment. A failed payment puts a page in front of the
--        CRM that can be skipped for a day at a time, and not at all once 72 hours have passed; from it, the
--        business may ask for more time, which opens a support ticket and is answered by staff.
--
--        **Cards are kept in `app.plan_cards`**, one row a card, each with the Stripe customer it is attached
--        to: a first payment, a renewal paid on a page of its own, and a card added from Settings → Billing & Usage can
--        each sit on a different customer, and a card can only be charged with its own. The default card is
--        still copied onto `app.workspace_plans` (`stripe_customer_id`, `stripe_card_id`), so the code running
--        now keeps charging the right card until the new code is up.
--
--        **One list pays the plan and the balance** (the owner's 5a): the default card is copied onto
--        `app.usage_wallets` too (`private.plan_sync_wallet_card`), so it refills the balance, and the worker tries
--        the backups when a top-up is declined. The balance's own card joins the list below.
--
--        **Retries** live on the plan (`retry_count`, `next_retry_at`, `retry_from`). The worker decides when
--        the next one is (a random time in the next day), and stops after its last; the database only answers
--        which are due (`private.plan_charges_due`, beside `private.founding_renewals_due`, which is unchanged).
--
--        **The payment day** is worked out here, once (`private.plan_pay_day_quote`), and the screens ask it:
--        what moving it costs now, or what it takes off the next payment. Moving it earlier happens at once and
--        leaves `pay_day_credit_cents` for the next charge (`private.founding_charge_cents` takes it off).
--        Moving it later waits on the charge (`pay_day_change_*`) and happens when the worker says it was paid.
--
--        **More time** is `app.plan_time_requests`: the date they think they can pay, a note, and the ticket it
--        opened. Staff grant it or not; a grant sets `more_time_until` on the plan, which lifts the page and
--        pauses the retries until that date.
--
--        **Only adds.** Nothing the running code calls changes shape; the balances that had a card other than the
--        plan's default are charged to that default from now on, and keep the other card as a backup.
-- =============================================================================

-- ---------- the cards ----------
create table app.plan_cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  -- Stripe's customer the card is attached to, and the card (`pm_…`). Ids only: Stripe holds the card.
  customer_ref text not null check (length(customer_ref) between 1 and 100),
  card_ref text not null check (length(card_ref) between 1 and 100),
  card_brand text check (card_brand is null or length(btrim(card_brand)) between 1 and 40),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_expiry_month smallint check (card_expiry_month is null or card_expiry_month between 1 and 12),
  card_expiry_year smallint check (card_expiry_year is null or card_expiry_year between 2000 and 2100),
  -- The one charged first. The others are backups, tried oldest first.
  is_default boolean not null default false,
  added_by uuid references app.users (id) on delete set null,
  -- The last time this card was declined, and what the bank said. Cleared when it next goes through.
  last_declined_at timestamptz,
  last_decline text check (last_decline is null or length(last_decline) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, card_ref)
);
create unique index plan_cards_one_default on app.plan_cards (workspace_id) where is_default;
create index plan_cards_workspace on app.plan_cards (workspace_id, created_at);
create trigger plan_cards_updated_at before update on app.plan_cards
  for each row execute function private.set_updated_at();

-- Whoever manages what the business pays us sees its cards (brand, last four, expiry), and staff. Nobody in a
-- business writes them directly: adding one is the worker's, after Stripe's page, and choosing the default or
-- removing one goes through the functions below, which check `money.manage` themselves.
alter table app.plan_cards enable row level security;
create policy plan_cards_read on app.plan_cards for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage')
         or private.staff_can('platform.founding.manage'));
create policy plan_cards_staff on app.plan_cards for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
create policy plan_cards_service on app.plan_cards for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update, delete on app.plan_cards to authenticated;
grant select, insert, update, delete on app.plan_cards to service_actor;
revoke all on app.plan_cards from anon;

-- The card each plan is charged to today becomes its default card. Its brand and last four aren't known here; the
-- worker asks Stripe for them (`plan_cards` with no `card_last4`).
insert into app.plan_cards (workspace_id, organization_id, customer_ref, card_ref, is_default)
select p.workspace_id, p.organization_id, p.stripe_customer_id, p.stripe_card_id, true
from app.workspace_plans p
where p.stripe_card_id is not null and p.stripe_customer_id is not null
on conflict (workspace_id, card_ref) do nothing;

-- ---------- retries, the payment day, and more time, on the plan ----------
alter table app.workspace_plans
  /** Automatic retries made since the payment failed. */
  add column retry_count integer not null default 0 check (retry_count >= 0),
  /** When the next automatic retry is due; null when none is (paid, or the last one has been made). */
  add column next_retry_at timestamptz,
  /** The day retries count from: when the payment failed, or the day more time ran out. */
  add column retry_from timestamptz,
  /** Taken off the next payment, after the payment day was moved earlier. */
  add column pay_day_credit_cents integer not null default 0 check (pay_day_credit_cents >= 0),
  /** A later payment day waiting on its charge: the new paid-through date, what it costs, and when it was asked. */
  add column pay_day_change_to timestamptz,
  add column pay_day_change_cents integer check (pay_day_change_cents is null or pay_day_change_cents >= 0),
  add column pay_day_change_asked_at timestamptz,
  add column pay_day_change_asked_by uuid references app.users (id) on delete set null,
  /** Why the last later payment day didn't go through. */
  add column pay_day_change_problem text check (pay_day_change_problem is null or length(pay_day_change_problem) <= 500),
  /** Staff gave the business until then to pay: no failed-payment page, and no retries, until it passes. */
  add column more_time_until timestamptz;

create index workspace_plans_retry_idx on app.workspace_plans (next_retry_at)
  where next_retry_at is not null;

-- ---------- asking for more time ----------
create type app.plan_time_request_status as enum ('pending', 'granted', 'declined');

create table app.plan_time_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  asked_by uuid references app.users (id) on delete set null,
  -- The day they think they can pay by.
  pay_by date not null,
  note text not null default '' check (length(note) <= 2000),
  ticket_id uuid references platform.tickets (id) on delete set null,
  status app.plan_time_request_status not null default 'pending',
  -- What staff gave: usually `pay_by`, sometimes another day.
  granted_until date,
  answered_by uuid references app.users (id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One waiting at a time.
create unique index plan_time_requests_one_pending on app.plan_time_requests (workspace_id)
  where status = 'pending';
create index plan_time_requests_workspace on app.plan_time_requests (workspace_id, created_at desc);
create trigger plan_time_requests_updated_at before update on app.plan_time_requests
  for each row execute function private.set_updated_at();

alter table app.plan_time_requests enable row level security;
-- Everyone in the business sees whether it was asked and answered (the failed-payment page says so to all).
create policy plan_time_requests_read on app.plan_time_requests for select to authenticated
  using (private.has_permission(workspace_id, 'workspace.read')
         or private.staff_can('platform.founding.manage'));
create policy plan_time_requests_staff on app.plan_time_requests for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
create policy plan_time_requests_service on app.plan_time_requests for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update, delete on app.plan_time_requests to authenticated;
grant select, insert, update, delete on app.plan_time_requests to service_actor;
revoke all on app.plan_time_requests from anon;

-- ---------- what a month or year costs ----------
/**
 * 20261027014300's charge, less what moving the payment day earlier took off the next one. Never below nothing.
 */
create or replace function private.founding_charge_cents(p_workspace uuid)
returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(p.price_cents
                  - case when p.discount_cents > 0
                          and (p.discount_until is null or p.current_period_end < p.discount_until)
                         then p.discount_cents else 0 end
                  - p.pay_day_credit_cents, 0)
  from app.workspace_plans p where p.workspace_id = p_workspace
$$;

/** The charge before any payment-day credit: what the period the plan is in costs. The payment-day sums use it. */
create or replace function private.plan_period_cents(p_workspace uuid)
returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(p.price_cents
                  - case when p.discount_cents > 0
                          and (p.discount_until is null or p.current_period_end < p.discount_until)
                         then p.discount_cents else 0 end, 0)
  from app.workspace_plans p where p.workspace_id = p_workspace
$$;

revoke all on function private.plan_period_cents(uuid) from public;
grant execute on function private.plan_period_cents(uuid) to authenticated, service_actor;

-- ---------- what the worker charges ----------
/**
 * Every plan with money due: a month or year that is up (as `private.founding_renewals_due`), and a failed one whose
 * next retry has come, unless staff gave it more time. `attempt` is 0 for the first try of a period and the retry's
 * number after that.
 */
create or replace function private.plan_charges_due(p_limit integer)
returns table (grant_id uuid, workspace_id uuid, organization_id uuid, paid_through timestamptz, attempt integer)
language sql stable security definer set search_path = '' as $$
  select g.id, p.workspace_id, p.organization_id, p.current_period_end,
         case when p.renewal_failed_at is null then 0 else p.retry_count + 1 end
  from app.workspace_plans p
  join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
    and g.workspace_id = p.workspace_id
  where p.current_period_end is not null and p.current_period_end <= now()
    and p.renewal_stopped_at is null and p.price_cents > 0
    and (
      (p.renewal_failed_at is null and p.status = 'active')
      or (p.renewal_failed_at is not null and p.status = 'past_due'
          and p.next_retry_at is not null and p.next_retry_at <= now()
          and (p.more_time_until is null or p.more_time_until <= now()))
    )
  order by coalesce(p.next_retry_at, p.current_period_end)
  limit greatest(1, least(p_limit, 500))
$$;

revoke all on function private.plan_charges_due(integer) from public;
grant execute on function private.plan_charges_due(integer) to service_actor;

/** Cards with no brand or last four yet (the ones copied over above), for the worker to ask Stripe about. */
create or replace function private.plan_cards_to_describe(p_limit integer)
returns table (card_id uuid, workspace_id uuid, organization_id uuid, customer_ref text, card_ref text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, c.organization_id, c.customer_ref, c.card_ref
  from app.plan_cards c
  where c.card_last4 is null
  order by c.created_at
  limit greatest(1, least(p_limit, 200))
$$;

revoke all on function private.plan_cards_to_describe(integer) from public;
grant execute on function private.plan_cards_to_describe(integer) to service_actor;

-- ---------- the business's own changes ----------
/** Refused unless the person manages what this business pays us. */
create or replace function private.plan_require_money_manager(p_workspace uuid)
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'Only somebody who manages money in workspace % can change its billing', p_workspace
      using errcode = '42501', detail = 'plan_billing_not_yours';
  end if;
end $$;

revoke all on function private.plan_require_money_manager(uuid) from public;
grant execute on function private.plan_require_money_manager(uuid) to authenticated;

/**
 * Puts the default card on the usage balance too (the owner's 5a, 2026-11-08: one list of cards pays the plan and
 * refills the balance). With no card left, the balance has none, and automatic top-up goes off with it, as
 * `wallet.forget_card` does. A new card is a fresh start for the decline ladder, as `wallet.record_card` says, and a
 * card going on where there was none turns automatic top-up on. A business without a wallet gets one only when it
 * has a card to put on it.
 *
 * The wallet's card is HandsFreeOS's to write (`private.guard_usage_wallet`), so this writes it in the business's own
 * scope, and puts back whatever scope the caller had.
 */
create or replace function private.plan_sync_wallet_card(p_workspace uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_card app.plan_cards;
  v_wallet app.usage_wallets;
  v_brand text;
  v_last4 text;
  v_prev text := coalesce(current_setting('app.system_scope.workspace_id', true), '');
begin
  select * into v_card from app.plan_cards c where c.workspace_id = p_workspace and c.is_default;
  select * into v_wallet from app.usage_wallets w where w.workspace_id = p_workspace for update;
  if v_wallet.workspace_id is null and v_card.id is null then
    return;
  end if;
  -- A brand and last four go on together or not at all (usage_wallets_card_details_check).
  if v_card.card_brand is not null and v_card.card_last4 is not null then
    v_brand := v_card.card_brand;
    v_last4 := v_card.card_last4;
  end if;
  if v_wallet.workspace_id is not null and (
       (v_card.id is null and v_wallet.method_token is null)
       or (v_card.id is not null
           and v_wallet.method_token is not distinct from v_card.card_ref
           and v_wallet.customer_ref is not distinct from v_card.customer_ref
           and v_wallet.provider is not distinct from 'stripe'::app.payment_provider
           and v_wallet.card_brand is not distinct from v_brand
           and v_wallet.card_last4 is not distinct from v_last4
           and v_wallet.card_expiry_month is not distinct from v_card.card_expiry_month
           and v_wallet.card_expiry_year is not distinct from v_card.card_expiry_year)) then
    return;
  end if;

  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
  if v_wallet.workspace_id is null then
    insert into app.usage_wallets (workspace_id, organization_id)
    values (p_workspace, v_card.organization_id)
    on conflict (workspace_id) do nothing;
    select * into v_wallet from app.usage_wallets w where w.workspace_id = p_workspace for update;
  end if;

  if v_card.id is null then
    update app.usage_wallets
       set method_token = null, card_brand = null, card_last4 = null,
           card_expiry_month = null, card_expiry_year = null, auto_topup = false
     where workspace_id = p_workspace;
  elsif v_wallet.method_token is not distinct from v_card.card_ref then
    -- The same card, with its details filled in (Stripe told us its brand and last four later).
    update app.usage_wallets
       set provider = 'stripe', customer_ref = v_card.customer_ref, card_brand = v_brand, card_last4 = v_last4,
           card_expiry_month = v_card.card_expiry_month, card_expiry_year = v_card.card_expiry_year
     where workspace_id = p_workspace;
  else
    update app.usage_wallets
       set provider = 'stripe', customer_ref = v_card.customer_ref, method_token = v_card.card_ref,
           card_brand = v_brand, card_last4 = v_last4,
           card_expiry_month = v_card.card_expiry_month, card_expiry_year = v_card.card_expiry_year,
           card_requested_at = null,
           declines_in_row = 0, paused_until = null, suspended_at = null, suspended_reason = null,
           auto_topup = case when v_wallet.method_token is null then true else v_wallet.auto_topup end
     where workspace_id = p_workspace;
  end if;
  perform set_config('app.system_scope.workspace_id', v_prev, true);
end $$;

revoke all on function private.plan_sync_wallet_card(uuid) from public;

/**
 * Copies the default card onto the plan, where the code before this one reads it, and onto the usage balance, which
 * the same cards pay.
 */
create or replace function private.plan_sync_default_card(p_workspace uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update app.workspace_plans p
     set stripe_customer_id = c.customer_ref, stripe_card_id = c.card_ref
    from app.plan_cards c
   where p.workspace_id = p_workspace and c.workspace_id = p_workspace and c.is_default
     and (p.stripe_card_id is distinct from c.card_ref or p.stripe_customer_id is distinct from c.customer_ref);
  perform private.plan_sync_wallet_card(p_workspace);
end $$;

revoke all on function private.plan_sync_default_card(uuid) from public;
grant execute on function private.plan_sync_default_card(uuid) to authenticated, service_actor;

/** Makes one card the default. The one that was the default becomes a backup. */
create or replace function private.plan_card_set_default(p_workspace uuid, p_card uuid)
returns table (card_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_card app.plan_cards;
begin
  perform private.plan_require_money_manager(p_workspace);
  select * into v_card from app.plan_cards c where c.id = p_card and c.workspace_id = p_workspace for update;
  if v_card.id is null then
    raise exception 'Card % is not on workspace %', p_card, p_workspace
      using errcode = 'P0002', detail = 'plan_card_missing';
  end if;
  if v_card.is_default then
    return query select v_card.id, false;
    return;
  end if;
  update app.plan_cards set is_default = false where workspace_id = p_workspace and is_default;
  update app.plan_cards set is_default = true where id = p_card;
  perform private.plan_sync_default_card(p_workspace);
  return query select v_card.id, true;
end $$;

revoke all on function private.plan_card_set_default(uuid, uuid) from public;
grant execute on function private.plan_card_set_default(uuid, uuid) to authenticated;

/**
 * Whether a founding plan that costs money renews on this business's cards: while one does, it keeps a card.
 */
create or replace function private.plan_needs_a_card(p_workspace uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.workspace_plans p
    join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
    where p.workspace_id = p_workspace and p.renewal_stopped_at is null and p.price_cents > 0
  )
$$;

revoke all on function private.plan_needs_a_card(uuid) from public;
grant execute on function private.plan_needs_a_card(uuid) to authenticated, service_actor;

/**
 * Takes a card off. The default can't be while there are others (another is made the default first), nor while a paid
 * plan renews on it; the last card of a business with nothing renewing can, and the balance loses it too. Answers what
 * Stripe should forget.
 */
create or replace function private.plan_card_remove(p_workspace uuid, p_card uuid)
returns table (customer_ref text, card_ref text, card_brand text, card_last4 text)
language plpgsql security definer set search_path = '' as $$
declare
  v_card app.plan_cards;
begin
  perform private.plan_require_money_manager(p_workspace);
  select * into v_card from app.plan_cards c where c.id = p_card and c.workspace_id = p_workspace for update;
  if v_card.id is null then
    raise exception 'Card % is not on workspace %', p_card, p_workspace
      using errcode = 'P0002', detail = 'plan_card_missing';
  end if;
  if v_card.is_default then
    if exists (select 1 from app.plan_cards c where c.workspace_id = p_workspace and c.id <> p_card) then
      raise exception 'Card % is the default on workspace %', p_card, p_workspace
        using errcode = '23514', detail = 'plan_card_is_default';
    end if;
    if private.plan_needs_a_card(p_workspace) then
      raise exception 'Card % is the only card on workspace %, whose plan renews', p_card, p_workspace
        using errcode = '23514', detail = 'plan_card_last_one';
    end if;
  end if;
  delete from app.plan_cards where id = p_card;
  if v_card.is_default then
    perform private.plan_sync_wallet_card(p_workspace);
  end if;
  return query select v_card.customer_ref, v_card.card_ref, v_card.card_brand, v_card.card_last4;
end $$;

revoke all on function private.plan_card_remove(uuid, uuid) from public;
grant execute on function private.plan_card_remove(uuid, uuid) to authenticated;

-- ---------- the payment day ----------
/**
 * What moving the payment day to `p_to` (a day, in UTC) would do, worked out from the period the plan is in. The
 * same time of day is kept, so the days are whole. `kind` is `later` (pay `cents` now, for the days added),
 * `earlier` (`cents` comes off the next payment, for the days given up) or `same`. `refusal` names why it can't be
 * done, or is null. Anyone in the business may ask; changing it is `private.plan_change_pay_day`.
 */
create or replace function private.plan_pay_day_quote(p_workspace uuid, p_to date)
returns table (
  kind text, days integer, cents integer, period_cents integer, period_days integer,
  paid_through timestamptz, new_paid_through timestamptz, earliest date, latest date, refusal text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan record;
  v_period interval;
  v_paid_day date;
  v_start timestamptz;
  v_period_days integer;
  v_period_cents integer;
  v_days integer;
  v_new timestamptz;
  v_earliest date;
  v_latest date;
begin
  select p.workspace_id, p.current_period_end, p.renewal_stopped_at, p.renewal_failed_at, p.status,
         p.trial_ends_at, p.renewal_count, p.pay_day_change_to, p.pay_day_change_asked_at, g.offer_id
    into v_plan
  from app.workspace_plans p
  join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
  where p.workspace_id = p_workspace;

  if v_plan.workspace_id is null or v_plan.current_period_end is null then
    return query select 'same', 0, 0, 0, 0, null::timestamptz, null::timestamptz, null::date, null::date,
      'plan_pay_day_no_plan';
    return;
  end if;
  v_period := private.founding_period(v_plan.offer_id);
  if v_period is null then
    return query select 'same', 0, 0, 0, 0, v_plan.current_period_end, null::timestamptz, null::date,
      null::date, 'plan_pay_day_no_plan';
    return;
  end if;

  v_paid_day := (v_plan.current_period_end at time zone 'UTC')::date;
  v_start := v_plan.current_period_end - v_period;
  v_period_days := greatest(1, round(extract(epoch from (v_plan.current_period_end - v_start)) / 86400)::integer);
  v_period_cents := coalesce(private.plan_period_cents(p_workspace), 0);
  -- Tomorrow at the earliest; and never more than a whole period later, less a day.
  v_earliest := least((now() at time zone 'UTC')::date + 1, v_paid_day);
  v_latest := ((v_plan.current_period_end + v_period) at time zone 'UTC')::date - 1;
  v_days := p_to - v_paid_day;
  v_new := ((p_to::timestamp + (v_plan.current_period_end at time zone 'UTC')::time) at time zone 'UTC');

  return query select
    case when v_days > 0 then 'later' when v_days < 0 then 'earlier' else 'same' end,
    abs(v_days),
    round(v_period_cents::numeric * abs(v_days) / v_period_days)::integer,
    v_period_cents,
    v_period_days,
    v_plan.current_period_end,
    v_new,
    v_earliest,
    v_latest,
    case
      when v_plan.renewal_stopped_at is not null then 'plan_pay_day_not_renewing'
      when v_plan.renewal_failed_at is not null or v_plan.status <> 'active' then 'plan_pay_day_past_due'
      when v_plan.trial_ends_at > now() and v_plan.renewal_count = 0 then 'plan_pay_day_trial'
      when v_plan.pay_day_change_to is not null
           and v_plan.pay_day_change_asked_at > now() - interval '15 minutes' then 'plan_pay_day_busy'
      when v_days = 0 then 'plan_pay_day_same'
      when p_to < v_earliest or v_plan.current_period_end <= now() then 'plan_pay_day_too_soon'
      when p_to > v_latest then 'plan_pay_day_too_late'
    end;
end $$;

revoke all on function private.plan_pay_day_quote(uuid, date) from public;
grant execute on function private.plan_pay_day_quote(uuid, date) to authenticated, service_actor;

/**
 * Moves the payment day. Earlier happens now: the paid-through date moves back and the days given up come off the
 * next payment. Later waits on its charge: what it costs is written down for the worker, which charges the cards and
 * then moves the date (`private.plan_apply_pay_day_change`). Answers what happened: `moved` or `charging`.
 */
create or replace function private.plan_change_pay_day(p_workspace uuid, p_to date)
returns table (outcome text, kind text, cents integer, paid_through timestamptz, new_paid_through timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_q record;
begin
  perform private.plan_require_money_manager(p_workspace);
  perform 1 from app.workspace_plans p where p.workspace_id = p_workspace for update;
  select * into v_q from private.plan_pay_day_quote(p_workspace, p_to);
  if v_q.refusal is not null then
    raise exception 'The payment day of workspace % can''t move to %', p_workspace, p_to
      using errcode = '23514', detail = v_q.refusal;
  end if;

  if v_q.kind = 'earlier' then
    update app.workspace_plans
       set current_period_end = v_q.new_paid_through,
           pay_day_credit_cents = pay_day_credit_cents + v_q.cents,
           pay_day_change_to = null, pay_day_change_cents = null, pay_day_change_asked_at = null,
           pay_day_change_asked_by = null, pay_day_change_problem = null
     where workspace_id = p_workspace;
    return query select 'moved', v_q.kind, v_q.cents, v_q.paid_through, v_q.new_paid_through;
    return;
  end if;

  update app.workspace_plans
     set pay_day_change_to = v_q.new_paid_through, pay_day_change_cents = v_q.cents,
         pay_day_change_asked_at = now(), pay_day_change_asked_by = auth.uid(), pay_day_change_problem = null
   where workspace_id = p_workspace;
  return query select 'charging', v_q.kind, v_q.cents, v_q.paid_through, v_q.new_paid_through;
end $$;

revoke all on function private.plan_change_pay_day(uuid, date) from public;
grant execute on function private.plan_change_pay_day(uuid, date) to authenticated;

-- ---------- more time ----------
/**
 * Asking for more time: a support ticket in the person's own name (`private.open_support_ticket`), and the request
 * beside it. Only while a payment has failed, up to 30 days out, one waiting at a time.
 */
create or replace function private.plan_ask_more_time(p_workspace uuid, p_pay_by date, p_note text,
                                                        p_subject text, p_body text)
returns table (request_id uuid, ticket_id uuid, ticket_number bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
  v_ticket uuid;
  v_number bigint;
  v_request uuid;
begin
  perform private.plan_require_money_manager(p_workspace);
  select p.workspace_id, p.organization_id, p.renewal_failed_at into v_plan
  from app.workspace_plans p where p.workspace_id = p_workspace for update;
  if v_plan.workspace_id is null or v_plan.renewal_failed_at is null then
    raise exception 'Nothing is owed in workspace %', p_workspace
      using errcode = '23514', detail = 'plan_more_time_nothing_owed';
  end if;
  if p_pay_by <= (now() at time zone 'UTC')::date or p_pay_by > (now() at time zone 'UTC')::date + 30 then
    raise exception 'More time in workspace % can''t run to %', p_workspace, p_pay_by
      using errcode = '23514', detail = 'plan_more_time_bad_date';
  end if;
  if exists (select 1 from app.plan_time_requests r where r.workspace_id = p_workspace and r.status = 'pending') then
    raise exception 'Workspace % already asked for more time', p_workspace
      using errcode = '23505', detail = 'plan_more_time_waiting';
  end if;

  select t.ticket_id, t.ticket_number into v_ticket, v_number
  from private.open_support_ticket(p_workspace, p_subject, p_body,
                                   jsonb_build_object('kind', 'plan_more_time', 'payBy', p_pay_by)) t;
  insert into app.plan_time_requests (workspace_id, organization_id, asked_by, pay_by, note, ticket_id)
  values (p_workspace, v_plan.organization_id, auth.uid(), p_pay_by, left(coalesce(p_note, ''), 2000), v_ticket)
  returning id into v_request;
  return query select v_request, v_ticket, v_number;
end $$;

revoke all on function private.plan_ask_more_time(uuid, date, text, text, text) from public;
grant execute on function private.plan_ask_more_time(uuid, date, text, text, text) to authenticated;

-- ---------- who to ask ----------
/**
 * The name of the business's first owner, for the failed-payment page of somebody who can't fix it ("Ask Dana to
 * update the card"). Anyone in the business may ask; a member may not otherwise read who else is in it.
 */
create or replace function private.plan_owner_name(p_workspace uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select nullif(btrim(u.full_name), '')
  from app.workspace_memberships m join app.users u on u.id = m.user_id
  where m.workspace_id = p_workspace and m.role = 'owner'
    and private.has_permission(p_workspace, 'workspace.read')
  order by m.created_at
  limit 1
$$;

revoke all on function private.plan_owner_name(uuid) from public;
grant execute on function private.plan_owner_name(uuid) to authenticated;

-- ---------- which founding seat ----------
/**
 * The name of the founding offer the business's plan is on, while its seat is still theirs; null once it's taken
 * back, or when there's none. A business can't read the grant itself (`revoke_reason` is written for us, about
 * them), so Settings → Billing & Usage and the failed-payment page learn from this whether the plan still bills.
 */
create or replace function private.plan_offer_name(p_workspace uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select o.name
  from app.workspace_plans p
  join platform.founding_grants g on g.id = p.grant_id and g.status = 'active'
  join platform.founding_offers o on o.id = g.offer_id
  where p.workspace_id = p_workspace
    and (private.has_permission(p_workspace, 'workspace.read')
         or private.staff_can('platform.founding.manage'))
$$;

revoke all on function private.plan_offer_name(uuid) from public;
grant execute on function private.plan_offer_name(uuid) to authenticated;

-- ---------- one list of cards, for the plan and the balance (the owner's 5a, 2026-11-08) ----------
-- The usage balance's card joins the list: the default when the business has none yet, a backup beside the plan's
-- card otherwise, so no card anybody added is lost.
insert into app.plan_cards (workspace_id, organization_id, customer_ref, card_ref, card_brand, card_last4,
  card_expiry_month, card_expiry_year, is_default)
select w.workspace_id, w.organization_id, w.customer_ref, w.method_token, w.card_brand, w.card_last4,
  w.card_expiry_month, w.card_expiry_year,
  not exists (select 1 from app.plan_cards c where c.workspace_id = w.workspace_id and c.is_default)
from app.usage_wallets w
where w.method_token is not null and w.customer_ref is not null
  and (w.provider is null or w.provider = 'stripe')
  and length(w.method_token) <= 100 and length(w.customer_ref) <= 100
on conflict (workspace_id, card_ref) do nothing;

-- Then the default card goes on each balance there is. A balance that had no card gets it with automatic top-up off,
-- so nothing is charged for usage that the business didn't turn on itself; one that had a card keeps its choice.
do $$
declare
  r record;
begin
  for r in
    select w.workspace_id, w.method_token is null as had_none
    from app.usage_wallets w
    join app.plan_cards c on c.workspace_id = w.workspace_id and c.is_default
    where w.method_token is distinct from c.card_ref
  loop
    perform private.plan_sync_wallet_card(r.workspace_id);
    if r.had_none then
      update app.usage_wallets set auto_topup = false where workspace_id = r.workspace_id;
    end if;
  end loop;
end $$;
