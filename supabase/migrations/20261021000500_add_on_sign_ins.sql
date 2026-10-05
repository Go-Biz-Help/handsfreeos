-- =============================================================================
-- An add-on's connections by sign-in (Real Estate, round five, step 7).
--
--        E-sign connects the brokerage's own DocuSign or Dotloop account by
--        signing in to it (OAuth), not by pasting a key. The sign-in works
--        as every other one does here (mailboxes, calendars, payments): a
--        one-time state, hashed, good for ten minutes, a PKCE verifier sealed
--        by the worker, and the callback connects nothing. It hands what came
--        back to the app, and only the person who pressed Connect, signed in,
--        finishes it.
--
--        **Who started it** is kept apart from who connected the account in
--        use, so connecting again doesn't rewrite who connected it first
--        until the new sign-in finishes.
-- =============================================================================

alter table app.addon_connections
  add column oauth_started_by uuid references app.users (id) on delete set null;
create index addon_connections_oauth_state_idx on app.addon_connections (oauth_state_hash)
  where oauth_state_hash is not null;
create index addon_connections_oauth_started_by_idx on app.addon_connections (oauth_started_by)
  where oauth_started_by is not null;

-- A sign-in under way, by its state's hash: for the worker's callback and finish, before it knows the business.
create or replace function private.addon_connection_by_state(p_state_hash bytea)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid, addon_id text, connector text,
               provider text, status text, started_by uuid, state_expires_at timestamptz, pkce_verifier_enc text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id, c.addon_id, c.connector, c.provider, c.status, c.oauth_started_by,
         c.oauth_state_expires_at, c.pkce_verifier_enc
  from app.addon_connections c join app.workspaces w on w.id = c.workspace_id
  where c.oauth_state_hash = p_state_hash and c.status <> 'disconnected'
$$;
revoke all on function private.addon_connection_by_state(bytea) from public;
grant execute on function private.addon_connection_by_state(bytea) to service_actor;
