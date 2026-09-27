-- =============================================================================
-- No overdraft once a business is on `enforce` (SEC-M18).
--
--        `overdraft_cents` is a business's own setting, up to $100,000, and
--        `enforce` is HandsFreeOS's. A business put on `enforce` for not
--        paying could raise its overdraft and keep texting and calling until
--        the balance reached -$100,000. The gate now reads the overdraft as
--        zero at `enforce`, and this refuses a business setting a non-zero
--        one there. Staff moving a business along are unchanged.
-- =============================================================================

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
  -- New here. At `enforce` the business stops at zero, and an overdraft it raised for itself would be the way
  -- round that. Lowering one to zero is still theirs; an unchanged one rides along with the other settings.
  if new.stage = 'enforce'
     and new.overdraft_cents is distinct from old.overdraft_cents
     and new.overdraft_cents <> 0 then
    raise exception 'A business stopped at zero has no overdraft to set'
      using errcode = '42501', detail = 'wallet_overdraft_enforced';
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
