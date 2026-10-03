-- =============================================================================
-- Photos on an inspection's findings (Real Estate round six, board 85).
--
--        A finding is taken at the inspection, often in a basement or an
--        attic with no signal: the phone keeps its photos and uploads them
--        later, as core files on the deal (as field notes' and the
--        walkthrough's are). Each finding keeps the ids of its photos, and
--        phones keep them with the rest of the finding (20261022000500's
--        columns, and photo_file_ids). The client's portal still reads only
--        what it read before.
-- =============================================================================

alter table addon_realestate.inspection_findings
  add column photo_file_ids uuid[] not null default '{}' check (cardinality(photo_file_ids) <= 10);

select private.addon_phone_table('addon_realestate.inspection_findings', 'deal_record_id', array['inspection_id',
  'title', 'location', 'severity', 'estimate_cents', 'client_priority', 'ask', 'credit_cents', 'position', 'note',
  'photo_file_ids']);
