-- =============================================================================
-- An add-on's webhooks (Real Estate, round five, step 2).
--
--        A service an add-on is connected to couldn't tell it anything: the
--        add-on guide listed "add-on webhook routes" under Not yet, since
--        app.webhook_deliveries.provider is a closed list and the worker had
--        no route for an add-on's service. A listing feed's updates and an
--        e-sign envelope being signed need exactly that.
--
--        **Its own address.** Each connection can have one
--        (/webhooks/addon/<token>); only the token's hash is kept
--        (webhook_token_hash, 20261021000100), so the address finds the
--        connection and nothing else. Opening it again replaces it, and
--        letting the connection go wipes it.
--
--        **Checked and kept once.** The worker checks the service's signature
--        with the connection's own webhook secret where the service signs,
--        then keeps each thing it says happened once, by the service's own id,
--        as a delivery for the add-on (provider `addon`). A service that
--        doesn't sign is kept with `signature_valid` false, and the add-on
--        reads what changed back from the service rather than trusting it.
--
--        **Handed to the add-on** by the delivery runner, under the guard
--        every add-on delivery has: off in that business, it's set aside.
-- =============================================================================

alter table app.webhook_deliveries
  drop constraint webhook_deliveries_provider_check,
  add constraint webhook_deliveries_provider_check
    check (provider in ('twilio', 'postmark', 'microsoft', 'google', 'fake', 'workflow', 'stripe', 'square', 'addon')),
  -- The connection it came in on. Kept as history once the connection is gone (null), and set aside then.
  add column addon_connection_id uuid references app.addon_connections (id) on delete set null,
  add constraint webhook_deliveries_addon_provider_check
    check (provider <> 'addon' or addon_id is not null);
create index webhook_deliveries_addon_connection_idx on app.webhook_deliveries (addon_connection_id)
  where addon_connection_id is not null;

-- The connection an add-on webhook's address belongs to, by its token's hash: for the worker's route, which
-- runs before it knows the business. Nothing for a connection that's been let go.
create or replace function private.addon_webhook_route(p_token_hash bytea)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid, addon_id text, connector text,
               provider text, status text, webhook_secret_enc text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id, c.addon_id, c.connector, c.provider, c.status, c.webhook_secret_enc
  from app.addon_connections c join app.workspaces w on w.id = c.workspace_id
  where c.webhook_token_hash = p_token_hash and c.status <> 'disconnected'
$$;
revoke all on function private.addon_webhook_route(bytea) from public;
grant execute on function private.addon_webhook_route(bytea) to service_actor;
