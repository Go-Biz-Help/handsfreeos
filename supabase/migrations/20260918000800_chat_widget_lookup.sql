-- =============================================================================
-- 0037 · Website chat: finding a widget by its public key. The chat window's
--        routes are signed out and know only the wk_… key from the snippet,
--        so the worker asks which business the key belongs to before it can
--        work inside that business (like private.booking_route for booking
--        pages). Only the worker (service_actor) may ask; it gets the ids it
--        needs to scope itself and whether the widget is paused, nothing else.
--        A key that isn't one (or was replaced by a new key) finds nothing.
-- =============================================================================

create or replace function private.chat_widget_lookup(p_public_key text)
returns table (widget_id uuid, workspace_id uuid, organization_id uuid, paused boolean)
language sql stable security definer set search_path = '' as $$
  select w.id, w.workspace_id, ws.organization_id, w.paused_at is not null
  from app.chat_widgets w
  join app.workspaces ws on ws.id = w.workspace_id
  where p_public_key ~ '^wk_[A-Za-z0-9]{20}$' and w.public_key = p_public_key
$$;

revoke all on function private.chat_widget_lookup(text) from public;
grant execute on function private.chat_widget_lookup(text) to service_actor;
