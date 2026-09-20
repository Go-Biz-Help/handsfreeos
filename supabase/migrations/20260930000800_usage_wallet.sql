-- =============================================================================
-- 0072 · The usage wallet: a balance, a ledger, and a card to fill it.
--
--        The second of the wallet's ten steps (M16). The rate card (0071) says
--        what things cost; this is where what a business has actually spent is
--        written down, and where the money to pay for it comes from.
--
--        **This is usage only.** Numbers, texts, calls and AI. A plan's own
--        subscription is a different thing with a different card, and nothing
--        here reads a plan, an entitlement or a trial — there is no such thing
--        in this repo yet. If a later milestone adds one, resist the urge to
--        "unify" the two: this wallet spends against a prepaid balance and a
--        subscription bills on a cycle, and a single table that tries to be
--        both ends up being neither. app.payments is likewise off limits: its
--        invoice_id is `not null` and it feeds the business's own receivables
--        roll-up, which is *their* customers' money, not ours.
--
--        **The one balance in the repo that may go negative.** Everywhere else
--        a money column is `>= 0`. Here it is not, because an inbound call and
--        an inbound text arrive whether or not there is money, and the carrier
--        has already billed us by the time we find out. Refusing them would
--        save almost nothing and would have the business's own customers hear
--        "not in service". So the balance goes under, by `overdraft_cents`,
--        and step 9's enforcement degrades outbound instead.
--
--        **The balance is cached, never summed on read.** Every text, call and
--        AI request reads it on the hot path. private.usage_wallet_apply()
--        locks the wallet row, adds the ledger row's amount and writes both
--        the wallet and the row's `balance_after_cents` — the same shape as
--        private.money_roll_up_invoice() in 0052. Application code never
--        writes balance_cents, and a nightly re-sum says so if it ever drifts.
--
--        **Nothing here is ever corrected in place.** The ledger is
--        append-only: a disagreement with a carrier's own daily records
--        inserts a second row with kind='adjustment', never an update. That
--        is what makes a month's statement something you can hand to somebody.
-- =============================================================================

-- ---------- what a ledger row is ----------
-- spend is usage (negative); topup is money in (positive); adjustment is a reconciliation either way; credit is
-- a goodwill or support credit; refund is money going back out of the balance.
create type app.usage_entry_kind as enum ('spend', 'topup', 'adjustment', 'credit', 'refund');

-- Where the number came from. `rate_card` is what we believed at the time; `provider` is a price the carrier
-- itself gave us; `reconciled` is an adjustment from their daily records. The three are told apart because the
-- margin column is only meaningful over the first two.
create type app.usage_cost_source as enum ('rate_card', 'provider', 'reconciled');

create type app.wallet_recharge_status as enum ('pending', 'succeeded', 'failed', 'cancelled');

-- ---------- the wallet ----------
create table app.usage_wallets (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  /**
   * What is left, in cents. **Written only by private.usage_wallet_apply().** Deliberately without a `>= 0`
   * check: see the header. It is checked against the ledger nightly and the drift shows on /admin health.
   */
  balance_cents bigint not null default 0,

  -- ---------- what the business chooses ----------
  auto_topup boolean not null default true,
  /** Below this, the wallet tops itself up. */
  floor_cents bigint not null default 1000 check (floor_cents >= 0 and floor_cents <= 100000000),
  /** How much one top-up adds. Escalation multiplies this, never replaces it. */
  topup_cents bigint not null default 2500 check (topup_cents >= 500 and topup_cents <= 100000000),
  /** How far under zero inbound usage may push it before step 9 starts degrading. */
  overdraft_cents bigint not null default 1000 check (overdraft_cents >= 0 and overdraft_cents <= 10000000),

  -- ---------- the card, which is the provider's and the worker's ----------
  -- Copied verbatim from app.subscriptions (0052), including the guard below: their id for the customer, their
  -- token for the card, and the brand, last four and expiry every provider gives for free. **Never the number.**
  provider app.payment_provider,
  customer_ref text check (customer_ref is null or length(btrim(customer_ref)) between 1 and 200),
  method_token text check (method_token is null or length(btrim(method_token)) between 1 and 4000),
  card_brand text check (card_brand is null or length(btrim(card_brand)) between 1 and 40),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_expiry_month smallint check (card_expiry_month is null or card_expiry_month between 1 and 12),
  card_expiry_year smallint check (card_expiry_year is null or card_expiry_year between 2000 and 2100),
  /** Set while we are waiting on somebody to put a card on it; cleared the moment one lands. */
  card_requested_at timestamptz,

  -- ---------- escalation ----------
  -- Chris's case: topping up four times in three days should cost one charge, not four. The window is rolling;
  -- the amount is topup_cents x 2^step. `escalation_step` is the only thing that decides an amount, so the
  -- ceilings in the worker have exactly one number to clamp.
  recharges_in_window int not null default 0 check (recharges_in_window >= 0),
  window_started_at timestamptz,
  escalation_step int not null default 0 check (escalation_step between 0 and 4),
  last_recharge_at timestamptz,

  -- ---------- declines ----------
  declines_in_row int not null default 0 check (declines_in_row >= 0),
  /** Set by the decline ladder: nothing is charged before this. */
  paused_until timestamptz,
  /** A wallet whose card has given up: outbound stops and the page asks for a new card. */
  suspended_at timestamptz,
  suspended_reason text check (suspended_reason is null or length(suspended_reason) <= 300),

  -- ---------- warnings ----------
  -- One crossing is one warning. The fingerprint mirrors attention_items.alert_fingerprint: while it is
  -- unchanged nothing is said again, and topping back up above the floor clears it.
  low_warned_at timestamptz,
  warn_fingerprint text check (warn_fingerprint is null or length(warn_fingerprint) <= 100),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A card is a set of things or none of them; a brand with no last four is a half-written row.
  constraint usage_wallets_card_details_check check ((card_brand is null) = (card_last4 is null)),
  constraint usage_wallets_card_token_check check (method_token is null or customer_ref is not null),
  constraint usage_wallets_suspended_check check ((suspended_at is null) = (suspended_reason is null))
);

create index usage_wallets_org_idx on app.usage_wallets (organization_id);
-- The sweep's own index: the wallets that might need topping up, without reading every wallet there is.
create index usage_wallets_needs_topup_idx on app.usage_wallets (workspace_id)
  where auto_topup and method_token is not null and suspended_at is null;

create trigger usage_wallets_updated_at before update on app.usage_wallets
  for each row execute function private.set_updated_at();
create trigger usage_wallets_immutable before update on app.usage_wallets
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'organization_id');

comment on column app.usage_wallets.balance_cents is
  'What is left, in cents. Written only by private.usage_wallet_apply(); may go negative, because inbound '
  'calls and texts arrive whether or not there is money and the carrier has already billed us.';

-- ---------- the ledger ----------
create table app.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  kind app.usage_entry_kind not null,
  /** Signed: negative is spend, positive is money in. Never zero — a row that changes nothing is noise. */
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  /** What is left after this row. Written by the trigger, so a statement shows a running balance with no window. */
  balance_after_cents bigint not null default 0,

  -- ---------- how it was priced ----------
  /** Our own cost before the markup, in cents. Null on a top-up, which costs us nothing to receive. */
  cost_cents bigint check (cost_cents is null or cost_cents >= 0),
  markup_bp int check (markup_bp is null or markup_bp >= 0),
  rate_card_version int,
  rate_key text,
  quantity numeric(18, 6) check (quantity is null or quantity >= 0),
  unit platform.usage_unit,
  cost_source app.usage_cost_source,

  -- ---------- what it was for ----------
  /** In words, for the statement: "Text to (512) 555-0134", "Call, 3 minutes". */
  subject text not null default '' check (length(subject) <= 300),
  /** What it was about, so a row on the statement links to the message, call or number it came from. */
  entity_type text check (entity_type is null or entity_type in
    ('message', 'call', 'phone_number', 'ai_usage', 'assistant_run', 'wallet_recharge')),
  entity_id uuid,
  /** The provider's own immutable id: a MessageSid, a CallSid. What the idempotency key is derived from. */
  provider_ref text check (provider_ref is null or length(btrim(provider_ref)) between 1 and 200),
  /**
   * Derived in one place (packages/core/src/money/usage-keys.ts) from the provider's id, so `sent`,
   * `delivered` and `undelivered` for one message all collapse to one row.
   */
  idempotency_key text not null check (length(btrim(idempotency_key)) between 3 and 200),
  /** A reconciliation says which row it corrects; a correction is never an update. */
  corrects_id uuid references app.usage_ledger (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Spend is out, top-ups and credits are in. An adjustment or a refund may be either way.
  constraint usage_ledger_direction_check check (
    case kind
      when 'spend' then amount_cents < 0
      when 'topup' then amount_cents > 0
      when 'credit' then amount_cents > 0
      when 'refund' then amount_cents < 0
      else true
    end),
  -- A priced row carries its whole price: the card it was priced from, the key, the quantity and the unit.
  constraint usage_ledger_priced_check check (
    rate_key is null or (rate_card_version is not null and quantity is not null and unit is not null
      and markup_bp is not null and cost_cents is not null and cost_source is not null))
);

-- **The idempotency rule.** Every insert is `on conflict do nothing returning id`; no rows back means the event
-- was already counted. This one index is what stops a webhook storm billing a text fifty times.
create unique index usage_ledger_idempotency on app.usage_ledger (workspace_id, idempotency_key);
-- The statement: one business's rows, newest first.
create index usage_ledger_statement_idx on app.usage_ledger (workspace_id, occurred_at desc, id desc);
-- The margin column in /admin: what was charged against what it cost, per key, over a period.
create index usage_ledger_margin_idx on app.usage_ledger (rate_key, occurred_at desc)
  where rate_key is not null;
create index usage_ledger_entity_idx on app.usage_ledger (entity_type, entity_id)
  where entity_id is not null;

comment on table app.usage_ledger is
  'Append-only. Every text, call, number and AI request a business is charged for, and every top-up. A '
  'disagreement with a carrier inserts an adjustment row that points at the one it corrects; nothing here is '
  'ever updated or deleted.';

-- ---------- the pending recharge ----------
-- Shaped like app.refunds (0052): the command writes `pending`, the job calls the provider, and a second
-- command records what came back. A decline is a recorded answer, not an exception.
create table app.wallet_recharges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  amount_cents bigint not null check (amount_cents between 100 and 100000000),
  status app.wallet_recharge_status not null default 'pending',
  /** Which step of the escalation ladder set this amount, for the sentence the page shows. */
  escalation_step int not null default 0 check (escalation_step between 0 and 4),
  /** A person pressed Top up, rather than the floor being crossed. A manual top-up never escalates. */
  requested_by uuid references app.users (id) on delete set null,
  provider app.payment_provider,
  provider_payment_id text
    check (provider_payment_id is null or length(btrim(provider_payment_id)) between 1 and 200),
  failure_code text check (failure_code is null or length(btrim(failure_code)) between 1 and 80),
  /** What the customer is told, from stripe.ts's own declineWording(). */
  failure_message text check (failure_message is null or length(failure_message) <= 300),
  /**
   * Written **before** the provider is called and handed to it unchanged. Stripe refuses a reused key with
   * different parameters, which is exactly the protection wanted: each retry is a new row with a new key.
   */
  idempotency_key text check (idempotency_key is null or length(btrim(idempotency_key)) between 8 and 100),
  /** The ledger row this recharge wrote, so a balance and a recharge can never disagree about what landed. */
  ledger_entry_id uuid references app.usage_ledger (id) on delete set null,
  succeeded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'succeeded') = (succeeded_at is not null)),
  check (failure_code is null or status = 'failed')
);

-- **One pending recharge per business.** This is what stops the escalation ladder firing twice at once when two
-- events cross the floor in the same second.
create unique index wallet_recharges_one_pending on app.wallet_recharges (workspace_id)
  where status = 'pending';
create unique index wallet_recharges_idempotency on app.wallet_recharges (workspace_id, idempotency_key)
  nulls not distinct where idempotency_key is not null;
create index wallet_recharges_recent_idx on app.wallet_recharges (workspace_id, created_at desc, id desc);

create trigger wallet_recharges_updated_at before update on app.wallet_recharges
  for each row execute function private.set_updated_at();
create trigger wallet_recharges_immutable before update on app.wallet_recharges
  for each row execute function private.forbid_tenant_column_change(
    'workspace_id', 'organization_id', 'amount_cents', 'requested_by', 'escalation_step');

-- ---------- the balance ----------
-- Before-insert and not after, so `balance_after_cents` is written on the row itself in the same statement.
-- The wallet row is locked first: two events arriving in the same millisecond queue up rather than both reading
-- the same balance and one of them overwriting the other.
create or replace function private.usage_wallet_apply()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_balance bigint;
begin
  select w.balance_cents into v_balance from app.usage_wallets w
    where w.workspace_id = new.workspace_id for update;
  if not found then
    -- A business spends before anybody opened its wallet: open one rather than lose the row. Its defaults are
    -- the table's, and the usage page explains itself the first time somebody looks.
    insert into app.usage_wallets (workspace_id, organization_id)
      values (new.workspace_id, new.organization_id)
      on conflict (workspace_id) do nothing;
    select w.balance_cents into v_balance from app.usage_wallets w
      where w.workspace_id = new.workspace_id for update;
  end if;
  v_balance := coalesce(v_balance, 0) + new.amount_cents;
  update app.usage_wallets set balance_cents = v_balance where workspace_id = new.workspace_id;
  new.balance_after_cents := v_balance;
  return new;
end $$;
create trigger usage_ledger_apply before insert on app.usage_ledger
  for each row execute function private.usage_wallet_apply();

-- ---------- the ledger is append-only, and the worker's ----------
-- An update or a delete raises, whoever asks — a person, the worker, a migration that meant well. The only way
-- to change what a statement says is to add a row that says what changed.
create or replace function private.guard_usage_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'The usage ledger is append-only: add an adjustment instead of changing a row'
      using errcode = '42501', detail = 'usage_ledger_append_only';
  end if;
  if private.system_scope_workspace() is distinct from new.workspace_id then
    raise exception 'Only HandsFreeOS writes the usage ledger'
      using errcode = '42501', detail = 'usage_ledger_is_ours';
  end if;
  return new;
end $$;
-- Named to sort before `usage_ledger_apply`: Postgres fires same-event triggers in name order, and refusing a
-- row before it has locked and moved a wallet is tidier than rolling both back.
create trigger usage_ledger_append_only before insert or update or delete on app.usage_ledger
  for each row execute function private.guard_usage_ledger();

-- ---------- the balance and the card are the worker's ----------
-- A person owns the four settings and nothing else. They may ask for a card (that is `card_requested_at`,
-- written through a command); what comes back from the provider, what the balance is, and where the escalation
-- and decline ladders have got to are all the worker's, exactly as a subscription's card is.
create or replace function private.guard_usage_wallet()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.balance_cents is distinct from old.balance_cents then
    raise exception 'The balance is worked out from the ledger, not written'
      using errcode = '42501', detail = 'wallet_balance_is_the_ledgers';
  end if;
  if new.provider is distinct from old.provider
    or new.customer_ref is distinct from old.customer_ref
    or new.method_token is distinct from old.method_token
    or new.card_brand is distinct from old.card_brand
    or new.card_last4 is distinct from old.card_last4
    or new.card_expiry_month is distinct from old.card_expiry_month
    or new.card_expiry_year is distinct from old.card_expiry_year then
    raise exception 'Only the provider decides what card a wallet holds'
      using errcode = '42501', detail = 'wallet_card_is_the_providers';
  end if;
  if new.recharges_in_window is distinct from old.recharges_in_window
    or new.window_started_at is distinct from old.window_started_at
    or new.escalation_step is distinct from old.escalation_step
    or new.last_recharge_at is distinct from old.last_recharge_at
    or new.declines_in_row is distinct from old.declines_in_row
    or new.paused_until is distinct from old.paused_until
    or new.suspended_at is distinct from old.suspended_at
    or new.suspended_reason is distinct from old.suspended_reason
    or new.low_warned_at is distinct from old.low_warned_at
    or new.warn_fingerprint is distinct from old.warn_fingerprint then
    raise exception 'Where the top-up and decline ladders have got to is HandsFreeOS''s to write'
      using errcode = '42501', detail = 'wallet_ladders_are_ours';
  end if;
  return new;
end $$;
create trigger usage_wallets_guard before update on app.usage_wallets
  for each row execute function private.guard_usage_wallet();

-- A wallet opens empty, with no card and nothing spent, whoever opens it.
--
-- A person has no insert policy here at all, so this is the second lock rather than the first — but it is the
-- one that speaks. Postgres fires BEFORE ROW triggers before it evaluates RLS's WITH CHECK, so an attempt to
-- open a wallet with money already in it is refused in those words rather than as a bare policy violation.
create or replace function private.guard_usage_wallet_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.balance_cents <> 0 or new.method_token is not null or new.customer_ref is not null
    or new.card_brand is not null or new.suspended_at is not null then
    raise exception 'A wallet opens empty, with no card on it'
      using errcode = '42501', detail = 'wallet_opens_empty';
  end if;
  return new;
end $$;
create trigger usage_wallets_insert_guard before insert on app.usage_wallets
  for each row execute function private.guard_usage_wallet_insert();

-- A recharge is the worker's from start to finish: a person presses Top up through a command, which is the
-- system actor by the time it writes.
create or replace function private.guard_wallet_recharge()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  raise exception 'Only HandsFreeOS writes a top-up'
    using errcode = '42501', detail = 'wallet_recharge_is_ours';
end $$;
create trigger wallet_recharges_guard before insert or update on app.wallet_recharges
  for each row execute function private.guard_wallet_recharge();

-- Status only moves forward, the same shape as private.payment_status_rank (0052): a late callback is kept
-- silently rather than raising, so a worker delivery does not fail and retry forever.
create or replace function private.wallet_recharge_rank(s app.wallet_recharge_status)
returns int language sql immutable set search_path = '' as $$
  select case s when 'pending' then 0 when 'failed' then 1 when 'cancelled' then 1 else 2 end
$$;

create or replace function private.guard_wallet_recharge_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.wallet_recharge_rank(new.status) < private.wallet_recharge_rank(old.status) then
    new.status := old.status;
  end if;
  return new;
end $$;
create trigger wallet_recharges_status before update on app.wallet_recharges
  for each row execute function private.guard_wallet_recharge_status();

-- ---------- row level security ----------
alter table app.usage_wallets enable row level security;
alter table app.usage_ledger enable row level security;
alter table app.wallet_recharges enable row level security;

-- Anyone who can see the business's money can see what it has spent: the same permission the Money tab uses,
-- rather than a fourth money permission nobody can keep straight.
create policy usage_wallets_read on app.usage_wallets for select to authenticated
  using (private.has_permission(workspace_id, 'money.read'));
-- The four settings, and asking for a card. Everything else on the row is refused by the guard above, which is
-- where the real rule lives — this policy only says who may try.
create policy usage_wallets_update on app.usage_wallets for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy usage_wallets_service on app.usage_wallets for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy usage_ledger_read on app.usage_ledger for select to authenticated
  using (private.has_permission(workspace_id, 'money.read'));
create policy usage_ledger_service on app.usage_ledger for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy wallet_recharges_read on app.wallet_recharges for select to authenticated
  using (private.has_permission(workspace_id, 'money.read'));
create policy wallet_recharges_service on app.wallet_recharges for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, update on app.usage_wallets to authenticated;
grant select on app.usage_ledger, app.wallet_recharges to authenticated;
grant select, insert, update, delete on app.usage_wallets, app.usage_ledger,
  app.wallet_recharges to service_actor;

-- ---------- staff ----------
-- /admin sees a business's wallet, and may put a credit on one with a reason. Two permissions, not a family:
-- reading a wallet rides on the businesses.read a staff member already has.
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.wallets.adjust');

-- ---------- the nightly check ----------
-- The cached balance is the thing every gate reads, so a drift is silent and then every gate lies. This re-sums
-- the ledger and reports the difference; the job that calls it raises a system event on anything non-zero and
-- /admin health shows it.
create or replace function private.usage_wallet_drift()
returns table (workspace_id uuid, cached_cents bigint, summed_cents bigint, drift_cents bigint)
language sql stable security definer set search_path = '' as $$
  select w.workspace_id, w.balance_cents,
    coalesce((select sum(l.amount_cents) from app.usage_ledger l where l.workspace_id = w.workspace_id), 0),
    w.balance_cents
      - coalesce((select sum(l.amount_cents) from app.usage_ledger l where l.workspace_id = w.workspace_id), 0)
  from app.usage_wallets w
  where w.balance_cents
    <> coalesce((select sum(l.amount_cents) from app.usage_ledger l where l.workspace_id = w.workspace_id), 0)
$$;

grant execute on function private.usage_wallet_drift() to service_actor;
