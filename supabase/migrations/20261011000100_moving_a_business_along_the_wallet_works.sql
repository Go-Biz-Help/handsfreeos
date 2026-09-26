-- =============================================================================
-- Moving a business along the wallet works.
--
--        `wallet.set_stage` (0075) was refused for every staff admin: "You do
--        not have permission to do that." `private.set_wallet_stage` put the
--        system's own scope on only while it opened a missing wallet, and took
--        it off again before the one write that mattered, the stage itself.
--        `private.guard_usage_wallet` lets a stage change through only under
--        that scope, so it refused every move, the first included. Nothing
--        tested it beyond its name.
--
--        The scope now covers the stage's write too, and is taken off after
--        it. The staff check still comes first, so a person without
--        `platform.wallets.adjust` never gets the scope at all.
-- =============================================================================

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
  -- This business's own scope, for the two writes below and nothing else.
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
  perform set_config('app.system_scope.workspace_id', '', true);
  return query select v_was, v_was is distinct from p_stage;
end $$;
