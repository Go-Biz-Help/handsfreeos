-- =============================================================================
-- Two more ways a lead arrives (funnels): a Facebook or Instagram lead ad's
-- form, and an applicant Indeed emails the business about, which the AI reads
-- (its tokens are counted as lead_intake). Alone in their file: new enum
-- values can't be used in the transaction that adds them (20261027011200
-- uses them).
-- =============================================================================

alter type app.intake_kind add value if not exists 'facebook_lead_ad';
alter type app.intake_kind add value if not exists 'indeed';
alter type app.ai_usage_source add value if not exists 'lead_intake';
