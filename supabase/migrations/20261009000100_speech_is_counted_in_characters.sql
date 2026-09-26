-- =============================================================================
-- The rate card learns a new unit: a thousand characters, which is how the
-- AI's voice (Deepgram Aura 2) is priced.
--
-- On its own because Postgres won't let a new enum value be used in the same
-- transaction that adds it, and the next migration prices a line in it.
-- =============================================================================

alter type platform.usage_unit add value if not exists 'kchar';
