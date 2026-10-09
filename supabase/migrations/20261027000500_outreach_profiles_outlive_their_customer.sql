-- =============================================================================
-- Social Outreach (outreach): a profile outlives its customer.
--
--        Deleting a customer for good (20261027000400) would have taken the
--        Facebook profile they were saved from with them, and its Don't
--        pitch mark, so the extension could offer to reach them again. Chris
--        decided (2026-10-08) that the profile and its mark stay, just no
--        longer linked to a contact: as for someone reached who isn't a
--        customer yet (20261026000300).
-- =============================================================================

alter table addon_outreach.profiles
  drop constraint profiles_person_id_fkey,
  add constraint profiles_person_id_fkey foreign key (person_id) references app.people (id) on delete set null;
