-- =============================================================================
-- 0075 · How far along the wallet a business is, one business at a time.
--
--        Ninth of the wallet's ten steps (M16), and the one that can actually
--        hurt somebody. Everything before this counted money; this is the
--        first thing that stops a text going out.
--
--        So it is off for everybody, and coming on is TWO deliberate acts, not
--        one:
--
--          off      nothing. The business does not know the wallet exists.
--          warn     it sees its balance and its statement, and is told when
--                   the balance is low or empty. Nothing stops.
--          enforce  the same, and outgoing texts and calls stop past the
--                   overdraft.
--
--        The middle rung is the point. A business whose phone stopped with no
--        warning would be right to be furious, and the terms now say we tell
--        them — so `warn` is the stretch where they can put a card on before
--        anything depends on it. Going straight from `off` to `enforce` is
--        possible and is nobody's plan.
--
--        There is no global switch, because a global switch is a way to turn
--        this on for a thousand businesses by accident at two in the morning.
--
--        The other half of the rule lives in the worker: WALLET_MODE decides
--        whether we COUNT (off / shadow / on), and this column decides whether
--        we SPEAK. That is what makes a shadow week silent — every balance goes
--        negative during one, and not one business hears a word about it.
--
--        Only staff may set it. A business cannot turn its own off — that would
--        not be a setting, it would be a way to run up a bill nobody can
--        collect.
-- =============================================================================

create type app.wallet_stage as enum ('off', 'warn', 'enforce');

alter table app.usage_wallets
  add column stage app.wallet_stage not null default 'off';

comment on column app.usage_wallets.stage is
  'How far along the wallet this business is: off (silent), warn (told, nothing stops) or enforce (stopped '
  'past the overdraft). Off everywhere until somebody moves it, per business (M16 step 9). Staff-only: '
  'private.guard_usage_wallet refuses a business writing its own.';

-- Read on the path of every outbound text, so the gate reads one row by primary key and nothing else. The
-- partial index is for counting a rollout ("who is on warn?"), which is the only query that scans.
create index usage_wallets_stage_idx on app.usage_wallets (stage) where stage <> 'off';

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
  if new.stage is distinct from old.stage then
    raise exception 'How far along the wallet this business is is HandsFreeOS''s to set'
      using errcode = '42501', detail = 'wallet_stage_is_ours';
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

-- ---------- moving a business along ----------
-- Staff-only, one business at a time, and it says where it came from so a rollout can be counted and an
-- accidental repeat is visibly a no-op.
create or replace function private.set_wallet_stage(p_workspace uuid, p_stage app.wallet_stage)
returns table (was app.wallet_stage, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was app.wallet_stage;
  v_org uuid;
begin
  if not private.staff_can('platform.wallets.adjust') then
    raise exception 'You cannot change where a business is on the wallet'
      using errcode = '42501', detail = 'wallets_adjust';
  end if;
  select stage into v_was from app.usage_wallets where workspace_id = p_workspace;
  if not found then
    -- A business that has never spent anything has no wallet yet, and putting it on `warn` before its first
    -- text is exactly how a careful rollout goes. Open one rather than refusing.
    select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
    if v_org is null then
      raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
    end if;
    perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
    insert into app.usage_wallets (workspace_id, organization_id) values (p_workspace, v_org)
      on conflict (workspace_id) do nothing;
    perform set_config('app.system_scope.workspace_id', '', true);
    v_was := 'off';
  end if;
  update app.usage_wallets set stage = p_stage where workspace_id = p_workspace;
  return query select v_was, v_was is distinct from p_stage;
end $$;

grant execute on function private.set_wallet_stage(uuid, app.wallet_stage) to authenticated, service_actor;

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
