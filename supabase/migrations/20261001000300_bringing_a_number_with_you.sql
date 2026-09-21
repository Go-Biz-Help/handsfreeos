-- =============================================================================
-- 0079 · Bringing your existing number with you, part 1: the status.
--
--        A number on its way to us from another carrier is neither
--        `provisioning` (we are buying it) nor `active` (it is ours and
--        working). It is `porting`: claimed, visible in Settings, nameable and
--        assignable, and not yet able to send anything.
--
--        In a migration of its own because **Postgres cannot use a new enum
--        value in the transaction that adds it** — the same reason 0030 exists.
--        The table, indexes and guard that use it follow in 0080.
-- =============================================================================

alter type app.phone_number_status add value if not exists 'porting' before 'active';
