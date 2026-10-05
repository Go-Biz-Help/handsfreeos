-- =============================================================================
-- Records reach phones (Real Estate round six, step 6).
--
--        The one batched sync change: apps/sync/sync-config.yaml gains the
--        records_v1 stream, which reads a person's keys (app.sync_keys), an
--        add-on's kinds and records, its rows for phones
--        (app.addon_phone_rows), and the sealed rows that hang off a private
--        record (20261022000100). PowerSync may read these four tables; their
--        seal columns decide who gets what and never leave for a phone.
-- =============================================================================

grant select on app.sync_keys, app.addon_phone_rows, app.custom_records, app.custom_record_types to hfos_sync;
alter publication powersync add table app.sync_keys, app.addon_phone_rows, app.custom_records, app.custom_record_types;
