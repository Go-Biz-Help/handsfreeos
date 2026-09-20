-- =============================================================================
-- 0081 · One enum value, alone in its own file.
--
--        Postgres will not let a transaction use an enum value it added in that
--        same transaction, and 0082 writes 'port' into a policy expression. So
--        this is the whole migration, exactly as 0030 split the knowledge value
--        out for the same reason.
--
--        A signed authorisation is a file that belongs to the *business*, like a
--        knowledge document and unlike a photo on a customer — so it gets a
--        record type of its own rather than being hung off some unrelated
--        person. Its record_id is the port it authorises.
-- =============================================================================

alter type app.record_type add value if not exists 'port';
