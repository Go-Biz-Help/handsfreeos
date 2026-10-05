-- =============================================================================
-- Check-ins reach the person's own phone (round six, step 12; core).
--
--        A check-in is made on the phone, often with no signal, and its
--        banner, +15 min and check-out must keep working while it lasts. So
--        records_v1 sends each person their own check-ins and safety contacts
--        in each business their phone keeps (apps/sync/sync-config.yaml),
--        exactly the rows the policies already give them: their own, in a
--        business they can open. Nobody else's, and never a contact's link.
-- =============================================================================

grant select on app.safety_checkins, app.safety_contacts to hfos_sync;
alter publication powersync add table app.safety_checkins, app.safety_contacts;
