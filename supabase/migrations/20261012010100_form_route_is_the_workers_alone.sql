-- =============================================================================
-- `private.form_route` is the worker's alone again.
--
--        0075's version was revoked from public and granted to service_actor
--        only. 20260930000300 dropped and re-created it to add
--        `embed_origins`, and a new function is executable by PUBLIC until
--        somebody says otherwise, so every signed-in session could read any
--        business's form definition and response count by its slugs. The
--        grant it re-issued was only the service_actor half; this is the
--        revoke it left out.
-- =============================================================================

revoke all on function private.form_route(text, text) from public, anon, authenticated;
grant execute on function private.form_route(text, text) to service_actor;
