-- =============================================================================
-- 0094 · A wallet opens the first time a business touches its balance.
--
--        A business that has never spent anything has no row in
--        `app.usage_wallets`. That is deliberate — a wallet is opened by the
--        first thing that needs one — and every path that needs one already
--        opens it: the ledger trigger when the first text is charged (0069),
--        `private.staff_credit_wallet` when support puts a credit on (0076),
--        `private.set_wallet_stage` when a rollout moves a business along
--        (0075).
--
--        Every path except the business's own. The four settings
--        (`wallet.set_auto_topup`) and the two buttons (`wallet.top_up`,
--        `wallet.forget_card`) are what a person with `money.manage` owns here,
--        and each opens the wallet lazily before it writes. Run as that person,
--        that insert is refused: `authenticated` has no INSERT privilege on the
--        table at all, and there is no insert policy for one. So the refusal came
--        as a bare 42501 — "You do not have permission to do that." — the first
--        time somebody set their top-up amount on a business that had not yet
--        sent a text. `wallet.request_card` had the same fault and was patched
--        in its own route; this replaces that patch with the rule itself.
--
--        The closed table is not the bug and is not loosened here. A person
--        still has no INSERT privilege, because what must stay impossible is a
--        person opening a wallet *of their choosing* — with a balance on it, a
--        card on it, or a `stage` they named rather than the one HandsFreeOS
--        puts a business on, which `guard_usage_wallet` refuses them on every
--        update and which the insert guard never looks at. Opening an EMPTY
--        one for a business they already run is harmless, and it is the only
--        thing this allows.
--
--        So it goes in the way the ledger's credit does: one `security
--        definer` function that checks `money.manage` for itself rather than
--        trusting its caller, takes nothing from that caller but the business,
--        and inserts defaults and only defaults. The organisation is read from
--        the workspace, so it cannot be misattributed. The balance is zero, the
--        card is absent and the stage is `off`, because those are the column
--        defaults and the function names no column. `guard_usage_wallet_insert`
--        still inspects the row afterwards and would refuse anything else.
--
--        The worker's own scope passes straight through, so the system paths
--        that open a wallet keep working with no change of behaviour.
-- =============================================================================

create or replace function private.open_usage_wallet(p_workspace uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  -- Asked first, and asked whether or not there is a wallet already. Short-circuiting on the row would
  -- answer quietly for a business that has one and refuse for a business that has not, which tells a
  -- stranger holding a workspace id something about it.
  --
  -- HandsFreeOS itself, or somebody who may spend this business's money. Nobody else, and a staff member
  -- is nobody else here: support opens a wallet through `private.staff_credit_wallet` or
  -- `private.set_wallet_stage`, which do their own `staff_can` check.
  if not coalesce(private.system_scope_workspace() = p_workspace, false)
    and not private.has_permission(p_workspace, 'money.manage') then
    raise exception 'You do not have permission to do that.'
      using errcode = '42501', detail = 'wallet_open_is_money_manage';
  end if;

  if exists (select 1 from app.usage_wallets w where w.workspace_id = p_workspace) then
    return;
  end if;

  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  if v_org is null then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;

  -- Defaults and nothing else: zero, no card, stage `off`. Two people pressing at once is one wallet.
  insert into app.usage_wallets (workspace_id, organization_id)
  values (p_workspace, v_org)
  on conflict (workspace_id) do nothing;
end $$;

grant execute on function private.open_usage_wallet(uuid) to authenticated, service_actor;
