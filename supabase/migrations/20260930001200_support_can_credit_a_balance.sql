-- =============================================================================
-- 0076 · Support can put a credit on a business's balance.
--
--        `wallet.adjust` shipped in step 5 (M16) and has never been callable
--        by anybody. Two reasons, and the second is the interesting one:
--
--        1. It paired `permission: 'platform.wallets.adjust'` with a WORKSPACE
--           scope. Every `platform.*` permission is checked against
--           `staffRole`, and `staffRole` is only set when a command resolves a
--           PLATFORM scope — so the check could never pass. That half is fixed
--           in TypeScript.
--
--        2. Even with the right scope it would still fail here. The usage
--           ledger is deliberately closed: there is no insert policy and no
--           insert grant for `authenticated` at all, and
--           `private.guard_usage_ledger()` additionally demands that the row's
--           workspace match `private.system_scope_workspace()`. That is not an
--           oversight to route around — it is the rule that makes a statement
--           trustworthy. A staff session is not the system.
--
--        So a credit goes in the way every other staff read of tenant data
--        does: one `security definer` function that checks
--        `private.staff_can` for itself. It sets the system scope for the
--        length of its own insert and clears it again, so "only HandsFreeOS
--        writes the ledger" stays literally true — this IS HandsFreeOS, saying
--        so out loud for exactly one row.
--
--        The credit shows on the business's statement like everything else.
--        Staff never write a balance: the row moves it, through the same
--        trigger every charge goes through.
-- =============================================================================

create or replace function private.staff_credit_wallet(
  p_workspace uuid,
  p_amount_cents bigint,
  p_reason text,
  p_reference text,
  p_by uuid
)
returns table (entry_id uuid, balance_cents bigint, recorded boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_entry uuid;
begin
  if not private.staff_can('platform.wallets.adjust') then
    raise exception 'You cannot adjust a balance' using errcode = '42501', detail = 'wallets_adjust';
  end if;
  if p_amount_cents = 0 then
    raise exception 'An adjustment of nothing is not an adjustment'
      using errcode = '22023', detail = 'adjustment_of_nothing';
  end if;

  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  if v_org is null then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;

  -- A business that has never spent anything has no wallet yet. Opening one to credit it is the obvious
  -- thing, and is what the command did before.
  insert into app.usage_wallets (workspace_id, organization_id)
  values (p_workspace, v_org)
  on conflict (workspace_id) do nothing;

  -- For this insert only. The guard's question is "is HandsFreeOS writing this?", and the answer here is yes;
  -- it is cleared immediately so nothing else in the caller's transaction inherits it.
  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);

  insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
    idempotency_key, meta, occurred_at)
  values (p_workspace, v_org,
    case when p_amount_cents > 0 then 'credit' else 'adjustment' end::app.usage_entry_kind,
    p_amount_cents, left(p_reason, 300), 'credit:' || p_reference,
    jsonb_build_object('reason', p_reason, 'reference', p_reference, 'by', p_by),
    now())
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_entry;

  perform set_config('app.system_scope.workspace_id', '', true);

  return query
    select v_entry, w.balance_cents, v_entry is not null
    from app.usage_wallets w where w.workspace_id = p_workspace;
end $$;

grant execute on function private.staff_credit_wallet(uuid, bigint, text, text, uuid)
  to authenticated, service_actor;
