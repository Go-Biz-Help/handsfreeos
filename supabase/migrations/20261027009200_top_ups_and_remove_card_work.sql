-- =============================================================================
-- Top up now works, the hourly top-up check can see the wallets it checks,
-- and a business can take its card off.
--
--        **Top up now never worked.** A top-up is HandsFreeOS's to write
--        from start to finish (private.guard_wallet_recharge), and
--        wallet.top_up wrote it as the person pressing the button, which
--        nothing allows: every press came back as "You don't have
--        permission to do that." private.request_wallet_top_up is now the
--        one way a press writes one, as private.open_usage_wallet is the
--        one way a press opens a wallet: it checks money.manage for itself
--        and writes the row the way HandsFreeOS does.
--
--        **The hourly top-up check found nobody.** The safety net behind
--        automatic top-up (planWallets in apps/worker/src/money/recharge.ts)
--        listed the wallets to sweep by reading app.usage_wallets with no
--        business in scope, and the worker's policy there only shows the
--        wallet of the business in scope. So it read nothing and never
--        armed a sweep, and a lost wallet.low was never caught.
--        private.wallets_to_top_up() answers its one question, as
--        private.telephony_accounts_open() does for the nightly check,
--        rather than a policy that would show the worker every wallet.
--
--        **Remove card never worked.** wallet.forget_card is the business's
--        own button, and private.guard_usage_wallet refused it whenever there
--        was a card to remove: a person changing any card column, clearing
--        it included, was "Only the provider decides what card a wallet
--        holds". The guard is made again as it was in
--        20261012030100_no_overdraft_once_enforced.sql, except that a person
--        may now clear the card. Putting one on or changing it is still the
--        provider's.
-- =============================================================================

-- The wallets that could need a top-up: a card, automatic top-up on, not suspended, and not paid for by the
-- agency.
create or replace function private.wallets_to_top_up()
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select w.workspace_id, w.organization_id
  from app.usage_wallets w
  where w.auto_topup and w.method_token is not null and w.suspended_at is null and w.stage <> 'agency'
  order by w.workspace_id
$$;

revoke all on function private.wallets_to_top_up() from public;
grant execute on function private.wallets_to_top_up() to service_actor;

-- ---------- a business may take its card off ----------
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
  -- New in 0075. A business turning off its own spending limit is not a setting, it is a way to run up a bill
  -- nobody can collect.
  if new.stage is distinct from old.stage then
    raise exception 'How far along the wallet this business is is HandsFreeOS''s to set'
      using errcode = '42501', detail = 'wallet_stage_is_ours';
  end if;
  -- New in 20261012030100. At `enforce` the business stops at zero, and an overdraft it raised for itself would be
  -- the way round that. Lowering one to zero is still theirs; an unchanged one rides along with the other settings.
  if new.stage = 'enforce'
     and new.overdraft_cents is distinct from old.overdraft_cents
     and new.overdraft_cents <> 0 then
    raise exception 'A business stopped at zero has no overdraft to set'
      using errcode = '42501', detail = 'wallet_overdraft_enforced';
  end if;
  -- Changed here. Taking the card off is the business's own button (wallet.forget_card), and this refused it: a
  -- person may clear the card, and never put one on or change it.
  if new.provider is distinct from old.provider
    or new.customer_ref is distinct from old.customer_ref
    or (new.method_token is not null and new.method_token is distinct from old.method_token)
    or (new.card_brand is not null and new.card_brand is distinct from old.card_brand)
    or (new.card_last4 is not null and new.card_last4 is distinct from old.card_last4)
    or (new.card_expiry_month is not null and new.card_expiry_month is distinct from old.card_expiry_month)
    or (new.card_expiry_year is not null and new.card_expiry_year is distinct from old.card_expiry_year) then
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

-- ---------- Top up now ----------
-- A person's press, written as HandsFreeOS writes a top-up: under the business's own scope, for this business only,
-- at step 0, and requested by whoever pressed. It takes the amount and the row's id and key (the key is derived in
-- core, and only there) and nothing else. Null when one is already on its way: one may wait per business.
create or replace function private.request_wallet_top_up(p_workspace uuid, p_amount_cents bigint, p_recharge uuid,
  p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_made uuid;
begin
  if not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'You do not have permission to do that.'
      using errcode = '42501', detail = 'wallet_top_up_is_money_manage';
  end if;
  select w.organization_id into v_org from app.usage_wallets w where w.workspace_id = p_workspace;
  if v_org is null then
    raise exception 'This business has no usage wallet' using errcode = '23503', detail = 'no_wallet';
  end if;
  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
  insert into app.wallet_recharges (id, workspace_id, organization_id, amount_cents, escalation_step, requested_by,
    idempotency_key)
  values (p_recharge, p_workspace, v_org, p_amount_cents, 0, auth.uid(), p_idempotency_key)
  on conflict do nothing
  returning id into v_made;
  perform set_config('app.system_scope.workspace_id', '', true);
  return v_made;
end $$;

revoke all on function private.request_wallet_top_up(uuid, bigint, uuid, text) from public;
grant execute on function private.request_wallet_top_up(uuid, bigint, uuid, text) to authenticated;
