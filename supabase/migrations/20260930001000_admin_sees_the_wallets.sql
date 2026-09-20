-- =============================================================================
-- 0074 · What /admin sees of the wallets, and the number that proves the markup.
--
--        Eighth of the wallet's ten steps (M16). Three things staff can see
--        that nobody could before:
--
--        **The margin column.** Charged against cost, per rate key, over a
--        period. This is the one number that says whether "at least one and a
--        half times what it costs us" is actually true — the rate card is a
--        set of guesses until a real week measures it, and a guess that is
--        wrong loses money quietly for a month. A realised markup under 1.2x
--        on any key is the standing alert the plan asks for.
--
--        **The wallets in trouble.** Suspended, declined today, and any wallet
--        whose cached balance disagrees with its own ledger. The last of those
--        is the silent one: the balance is what every spending gate reads, so
--        a drift means every gate is lying.
--
--        **One business's wallet**, for the support desk, so a ticket saying
--        "my texts stopped" can be answered without asking them to read a page
--        back over the phone.
--
--        Nothing here is tenant-scoped, because none of it is tenant data: it
--        is HandsFreeOS's own books. Every function is staff-only.
-- =============================================================================

-- ---------- the margin ----------
-- Rate cards change, so this reports by key rather than by card version: a key's realised markup over a period
-- is what matters, whichever version priced each event inside it.
--
-- `charged` is the absolute value, because spend is negative in the ledger. Adjustments count: a carrier's own
-- daily records correcting us is exactly the thing this is meant to catch, and leaving them out would report a
-- margin we only believed we had.
create or replace function private.admin_usage_margin(p_since timestamptz)
returns table (
  rate_key text,
  events bigint,
  charged_cents bigint,
  cost_cents bigint,
  /** Charged over cost. Null where nothing cost us anything, which is not a margin of infinity. */
  realised numeric,
  /** What the live card intends, for comparison: a gap between the two is rounding, floors or reconciliation. */
  card_markup_bp int
)
language sql stable security definer set search_path = '' as $$
  select
    l.rate_key,
    count(*),
    sum(abs(l.amount_cents)),
    sum(coalesce(l.cost_cents, 0)),
    case when sum(coalesce(l.cost_cents, 0)) > 0
      then round(sum(abs(l.amount_cents))::numeric / sum(l.cost_cents)::numeric, 4) end,
    (select r.markup_bp from platform.usage_rates_live r where r.key = l.rate_key)
  from app.usage_ledger l
  where l.rate_key is not null and l.kind in ('spend', 'adjustment') and l.occurred_at > p_since
    and private.staff_can('platform.rates.manage')
  group by l.rate_key
  order by l.rate_key
$$;

grant execute on function private.admin_usage_margin(timestamptz) to authenticated, service_actor;

-- ---------- the wallets that need looking at ----------
create or replace function private.admin_wallet_health(p_since timestamptz)
returns table (
  suspended bigint,
  declines bigint,
  drifting bigint,
  negative bigint,
  /** Days the reconciler has not run for a business that has a carrier account. */
  unreconciled_days bigint
)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.usage_wallets w where w.suspended_at is not null),
    (select count(*) from app.wallet_recharges r where r.status = 'failed' and r.updated_at > p_since),
    (select count(*) from private.usage_wallet_drift()),
    (select count(*) from app.usage_wallets w where w.balance_cents < 0),
    (select count(*) from app.scheduled_jobs j
      where j.kind = 'wallet.reconcile' and j.status = 'failed' and j.updated_at > p_since)
  where private.staff_can('platform.health.read')
$$;

grant execute on function private.admin_wallet_health(timestamptz) to authenticated, service_actor;

-- ---------- one business's wallet ----------
-- For the support desk. Costs are included here and nowhere a business can see: staff answering "why was I
-- charged 2c for that text" need the whole picture, and a customer needs the price.
create or replace function private.admin_wallet_for(p_workspace uuid)
returns table (
  balance_cents bigint,
  auto_topup boolean,
  floor_cents bigint,
  topup_cents bigint,
  has_card boolean,
  card_brand text,
  card_last4 text,
  suspended_at timestamptz,
  suspended_reason text,
  declines_in_row int,
  escalation_step int,
  spent_30d_cents bigint,
  cost_30d_cents bigint,
  topped_up_30d_cents bigint
)
language sql stable security definer set search_path = '' as $$
  select w.balance_cents, w.auto_topup, w.floor_cents, w.topup_cents,
    w.method_token is not null, w.card_brand, w.card_last4, w.suspended_at, w.suspended_reason,
    w.declines_in_row, w.escalation_step,
    coalesce((select sum(abs(l.amount_cents)) from app.usage_ledger l
      where l.workspace_id = w.workspace_id and l.amount_cents < 0
        and l.occurred_at > now() - interval '30 days'), 0),
    coalesce((select sum(coalesce(l.cost_cents, 0)) from app.usage_ledger l
      where l.workspace_id = w.workspace_id and l.occurred_at > now() - interval '30 days'), 0),
    coalesce((select sum(l.amount_cents) from app.usage_ledger l
      where l.workspace_id = w.workspace_id and l.kind = 'topup'
        and l.occurred_at > now() - interval '30 days'), 0)
  from app.usage_wallets w
  where w.workspace_id = p_workspace and private.staff_can('platform.businesses.read')
$$;

grant execute on function private.admin_wallet_for(uuid) to authenticated, service_actor;
