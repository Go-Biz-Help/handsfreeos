-- =============================================================================
-- Video meetings: someone removed the HandsFreeOS app in Zoom. Zoom's webhook
--        (app_deauthorized) names the Zoom user, not a business, so the worker
--        finds that person's live Zoom connections in every business here,
--        then disconnects each one and erases what it kept from Zoom (tokens,
--        the account's email and id, its scopes and settings).
-- =============================================================================

create index meeting_connections_external_user_idx on app.meeting_connections (provider, external_user_id)
  where external_user_id is not null;

create or replace function private.meeting_connections_by_external_user(p_provider text, p_external_user_id text)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id
  from app.meeting_connections c join app.workspaces w on w.id = c.workspace_id
  where c.provider::text = p_provider and c.external_user_id = p_external_user_id
    and c.status <> 'disconnected'
$$;

revoke all on function private.meeting_connections_by_external_user(text, text) from public;
grant execute on function private.meeting_connections_by_external_user(text, text) to service_actor;
