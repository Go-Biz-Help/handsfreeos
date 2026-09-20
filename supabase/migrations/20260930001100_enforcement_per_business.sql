-- =============================================================================
-- 0075 · Enforcement, one business at a time.
--
--        Ninth of the wallet's ten steps (M16), and the one that can actually
--        hurt somebody. Everything before this counted money; this is the
--        first thing that stops a text going out.
--
--        So it is off for everybody. `enforced` is false on every wallet,
--        including ones that already exist, and turning it on is a deliberate
--        act per business: internal first, then a cohort, then everyone. There
--        is no global switch, because a global switch is a way to turn this on
--        for a thousand businesses by accident at two in the morning.
--
--        Only staff may set it. A business cannot turn its own enforcement off
--        — that would not be a setting, it would be a way to spend money we
--        have no way of collecting.
-- =============================================================================

alter table app.usage_wallets
  add column enforced boolean not null default false;

comment on column app.usage_wallets.enforced is
  'Whether a zero balance actually stops this business sending. False everywhere until somebody turns it on '
  'per business (M16 step 9). Staff-only: private.guard_usage_wallet refuses a business writing its own.';

-- The gate reads this on the path of every outbound text, so it reads one row by primary key and nothing else.
create index usage_wallets_enforced_idx on app.usage_wallets (workspace_id) where enforced;

-- ---------- a business never writes its own ----------
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
  if new.enforced is distinct from old.enforced then
    raise exception 'Whether a balance stops this business sending is HandsFreeOS''s to set'
      using errcode = '42501', detail = 'wallet_enforcement_is_ours';
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

-- ---------- turning it on ----------
-- Staff-only, one business at a time, and it says what it did so a rollout can be counted.
create or replace function private.set_wallet_enforcement(p_workspace uuid, p_on boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_was boolean;
begin
  if not private.staff_can('platform.wallets.adjust') then
    raise exception 'You cannot change enforcement' using errcode = '42501', detail = 'wallets_adjust';
  end if;
  select enforced into v_was from app.usage_wallets where workspace_id = p_workspace;
  if not found then
    raise exception 'That business has no usage wallet' using errcode = '23503', detail = 'no_wallet';
  end if;
  update app.usage_wallets set enforced = p_on where workspace_id = p_workspace;
  return v_was is distinct from p_on;
end $$;

grant execute on function private.set_wallet_enforcement(uuid, boolean) to authenticated, service_actor;

-- ---------- what the AI teammate says when it stops ----------
-- The teammate never errors at a customer. When the balance runs out it hands the conversation to a person,
-- the same way it does for its daily AI limit — so the reason needs a name of its own, or every one of these
-- would read "something went wrong" in the inbox and in the audit log.
alter table app.conversations
  drop constraint conversations_handoff_reason_check;

alter table app.conversations
  add constraint conversations_handoff_reason_check check (handoff_reason is null or handoff_reason in (
    'asked_for_person', 'frustrated', 'cant_answer', 'sensitive', 'emergency', 'legal', 'complaint', 'refund',
    'cancellation', 'limit', 'budget', 'wallet', 'error', 'draft_expired', 'loop', 'other'));
