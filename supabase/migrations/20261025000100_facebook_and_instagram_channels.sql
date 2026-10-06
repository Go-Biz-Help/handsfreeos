-- =============================================================================
-- Facebook Messenger and Instagram direct messages are channels of their own,
-- kinds of timeline line, and ways a stranger becomes a lead. Alone in their
-- file: new enum values can't be used in the transaction that adds them
-- (20261025000200 uses them).
-- =============================================================================

alter type app.channel add value if not exists 'messenger';
alter type app.channel add value if not exists 'instagram';
alter type app.activity_kind add value if not exists 'messenger';
alter type app.activity_kind add value if not exists 'instagram';
alter type app.intake_kind add value if not exists 'messenger';
alter type app.intake_kind add value if not exists 'instagram';
