-- =============================================================================
-- Real Estate's closed days on phones (round six, step 13).
--
--        Coordinate counts business days around the days the business is
--        closed (Deal settings → Closed days). Phones keep that one setting
--        (the manifest's offline.settings), so Today, Exceptions and the
--        Waiting room read the same with no signal.
-- =============================================================================

select private.addon_phone_settings('realestate', array['closedDays']);
