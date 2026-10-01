-- =============================================================================
-- The rate card learns a new unit: a one-off fee, which is how the carriers
-- charge for registering a business to text from a local number.
--
-- On its own because Postgres won't let a new enum value be used in the same
-- transaction that adds it, and the next migration prices lines in it.
-- =============================================================================

alter type platform.usage_unit add value if not exists 'fee';
