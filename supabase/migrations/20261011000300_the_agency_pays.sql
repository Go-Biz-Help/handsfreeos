-- =============================================================================
-- What `agency` does in the database, and the stage the support desk sees.
--
--        - Moving a business off `agency` settles what the agency paid for: a
--          credit, "Paid by the agency", brings a negative balance back to
--          zero, so the business doesn't start out owing what it used while
--          it was paid for. It shows on their statement like any credit.
--        - `private.admin_wallet_for` now says the stage. It never did, so the
--          admin page read every business as "Silent", whatever it was on.
--        - The health count of wallets below zero leaves out the ones the
--          agency pays for: below zero is what they are for.
-- =============================================================================

create or replace function private.set_wallet_stage(p_workspace uuid, p_stage app.wallet_stage)
returns table (was app.wallet_stage, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was app.wallet_stage;
  v_org uuid;
  v_balance bigint;
begin
  if not private.staff_can('platform.wallets.adjust') then
    raise exception 'You cannot change where a business is on the wallet'
      using errcode = '42501', detail = 'wallets_adjust';
  end if;
  -- This business's own scope, for the writes below and nothing else.
  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
  select stage into v_was from app.usage_wallets where workspace_id = p_workspace;
  if not found then
    -- A business that has never spent anything has no wallet yet, and putting it on `warn` before its first
    -- text is exactly how a careful rollout goes. Open one rather than refusing.
    select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
    if v_org is null then
      perform set_config('app.system_scope.workspace_id', '', true);
      raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
    end if;
    insert into app.usage_wallets (workspace_id, organization_id) values (p_workspace, v_org)
      on conflict (workspace_id) do nothing;
    v_was := 'off';
  end if;
  update app.usage_wallets set stage = p_stage where workspace_id = p_workspace;
  -- Leaving the agency's care: what it paid for is settled, so they don't start out owing it.
  if v_was = 'agency' and p_stage <> 'agency' then
    select w.balance_cents, w.organization_id into v_balance, v_org
      from app.usage_wallets w where w.workspace_id = p_workspace;
    if v_balance < 0 then
      insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
        idempotency_key, meta, occurred_at)
      values (p_workspace, v_org, 'credit', -v_balance, 'Paid by the agency',
        'agency-paid:' || gen_random_uuid()::text,
        jsonb_build_object('reason', 'Paid by the agency', 'by', auth.uid()), now());
    end if;
  end if;
  perform set_config('app.system_scope.workspace_id', '', true);
  return query select v_was, v_was is distinct from p_stage;
end $$;

-- The same as before with the stage first; the return type changes, so it is dropped and made again.
drop function private.admin_wallet_for(uuid);
create function private.admin_wallet_for(p_workspace uuid)
returns table (
  stage text,
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
  select w.stage::text, w.balance_cents, w.auto_topup, w.floor_cents, w.topup_cents,
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
    (select count(*) from app.usage_wallets w where w.balance_cents < 0 and w.stage <> 'agency'),
    (select count(*) from app.scheduled_jobs j
      where j.kind = 'wallet.reconcile' and j.status = 'failed' and j.updated_at > p_since)
  where private.staff_can('platform.health.read')
$$;
