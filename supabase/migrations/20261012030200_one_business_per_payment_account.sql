-- =============================================================================
-- One business per payment account (SEC-M6).
--
--        A Stripe or Square account's webhooks are routed by the account id
--        alone (`private.payment_connection_by_account`), newest live row
--        first. The live-account unique index was per workspace, so a second
--        business connecting the same account took over every event for it:
--        the first one's invoices never marked paid, and the second one
--        stored its customers' payments.
--
--        A live connection is now unique per provider account across the
--        whole platform, and `payment_connection.activate` asks
--        `private.payment_account_live_elsewhere` first so it can say so in
--        words rather than as a bare unique violation.
-- =============================================================================

-- Whether another business holds a live connection to this account, in either environment: a webhook names
-- the account and not the environment, so a test connection elsewhere misroutes the same way.
create or replace function private.payment_account_live_elsewhere(
  p_provider text, p_external_id text, p_workspace uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.payment_connections pc
    where pc.provider::text = p_provider
      and pc.external_account_id = p_external_id
      and pc.workspace_id <> p_workspace
      and pc.status <> 'disconnected')
$$;
revoke all on function private.payment_account_live_elsewhere(text, text, uuid) from public;
grant execute on function private.payment_account_live_elsewhere(text, text, uuid) to service_actor;

-- The index itself. Two businesses already sharing a live account can't be sorted out by a migration (which
-- one is the real owner is a question for support), so the old per-workspace index stays until they are, and
-- this says so rather than failing the deploy. The command above holds the line either way.
do $$
begin
  if exists (
    select 1 from app.payment_connections
    where status <> 'disconnected' and external_account_id is not null
    group by provider, environment, external_account_id
    having count(distinct workspace_id) > 1
  ) then
    raise warning 'payment_connections: an account is live in more than one business; the live-account index stays per workspace until support resolves it';
  else
    drop index if exists app.payment_connections_live_account;
    create unique index payment_connections_live_account on app.payment_connections
      (provider, environment, external_account_id)
      where status <> 'disconnected' and external_account_id is not null;
  end if;
end $$;
