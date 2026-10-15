-- =============================================================================
-- The main offer: more room to write (packages/core/src/main-offer/parts.ts, MAIN_OFFER_LIMITS). The one-line offer
-- goes from 600 characters to 1,200, and the sentence-or-two boxes from 600 to 800; those live in the parts' JSON,
-- which keeps its overall size check.
--
-- Only widens: every version kept already fits, and the code running now writes nothing this refuses.
-- =============================================================================

alter table app.main_offer_versions drop constraint main_offer_versions_line_check,
  add constraint main_offer_versions_line_check check (length(btrim(line)) between 1 and 1200);
