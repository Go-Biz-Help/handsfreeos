-- =============================================================================
-- Messages in a customer's portal are a channel of their own, and a kind of
-- timeline line (Real Estate round two, step 5; core). Alone in their file:
-- new enum values can't be used in the transaction that adds them
-- (20261014000700 uses them).
-- =============================================================================

alter type app.channel add value if not exists 'portal';
alter type app.activity_kind add value if not exists 'portal';
