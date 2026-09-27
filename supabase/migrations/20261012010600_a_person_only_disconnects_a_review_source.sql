-- =============================================================================
-- A person may disconnect a review source, and do nothing else to it.
--
--        0080 granted `authenticated` update on the sign-in columns so that
--        disconnecting could clear them, and said in a comment that this was
--        all a person could do. Nothing enforced it: with `reviews.manage`, a
--        direct update could re-arm a finished sign-in (a fresh
--        `oauth_state_hash` and expiry), swap the sealed token for another
--        connection's, or bring a disconnected source back. The one command a
--        person runs, `review_connection.disconnect`, clears everything and
--        sets `disconnected`; this guard makes that the only update a person
--        can make, and does the clearing itself so nothing is left behind.
--
--        The worker (connecting, reading, failing) runs in the business's own
--        system scope and is not affected.
-- =============================================================================

create or replace function private.guard_review_connection_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status = 'disconnected' or new.status is distinct from 'disconnected' then
    raise exception 'People can only disconnect a review source'
      using errcode = '42501', detail = 'review_connection_disconnect_only';
  end if;
  new.disconnected_at := now();
  new.disconnected_reason := 'person';
  new.next_sync_at := null;
  new.token_enc := null;
  new.token_key_id := null;
  new.pkce_verifier_enc := null;
  new.oauth_state_hash := null;
  new.oauth_state_expires_at := null;
  return new;
end $$;
drop trigger if exists review_connections_update_guard on app.review_connections;
create trigger review_connections_update_guard before update on app.review_connections
  for each row execute function private.guard_review_connection_update();

revoke all on function private.guard_review_connection_update() from public;
