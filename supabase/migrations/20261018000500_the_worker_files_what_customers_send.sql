-- =============================================================================
-- The worker files what a customer sends.
--
--        A file a qualifying question asks for (20261018000400) goes on the
--        lead's Files as the customer sends it: through the link, as the
--        worker's own command, or saved by the AI teammate, which runs as the
--        worker too. Until now only a signed-in person ever added a file, so
--        the worker could read, change and remove one (0009) but not add one.
--
--        files_service_all already keeps the worker to the business it is
--        working for, as it does for every other kind of row.
-- =============================================================================

grant insert on app.files to service_actor;
