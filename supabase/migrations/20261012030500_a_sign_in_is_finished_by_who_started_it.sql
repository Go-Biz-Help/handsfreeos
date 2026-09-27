-- =============================================================================
-- A sign-in is finished by the person who started it (SEC-M1, SEC-M7).
--
--        The one-time state a Connect press makes travels in a link, and a
--        link can be forwarded: an account somebody else approves was being
--        connected to the business of whoever sent it. The worker now
--        finishes a sign-in only when the app posts it back signed in as the
--        person who pressed Connect, and this is how it asks who that was,
--        across every door a state is made for.
-- =============================================================================

create or replace function private.oauth_state_started_by(p_state_hash text)
returns uuid language sql stable security definer set search_path = '' as $$
  select x.created_by from (
    select mc.created_by from app.mailbox_connections mc where mc.oauth_state_hash = p_state_hash
    union all
    select cc.created_by from app.calendar_connections cc where cc.oauth_state_hash = p_state_hash
    union all
    select pc.created_by from app.payment_connections pc where pc.oauth_state_hash = p_state_hash
    union all
    select rc.created_by from app.review_connections rc where rc.oauth_state_hash = p_state_hash
    union all
    select mg.created_by from app.migration_connections mg where mg.oauth_state_hash = p_state_hash
  ) x
  limit 1
$$;

revoke all on function private.oauth_state_started_by(text) from public;
grant execute on function private.oauth_state_started_by(text) to service_actor;
