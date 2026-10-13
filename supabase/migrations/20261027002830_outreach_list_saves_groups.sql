-- =============================================================================
-- Social Outreach: the person's groups, saved and checked before their first day too (docs/outreach.md, "Lists
-- first", decision 60).
--
-- The owner's decision (settled): the first time, Start my day also waits until the person's groups are saved and
-- checked. After that, the groups are saved again weekly, and checked by the daily group checks.
--
--        `groups_at` is when the person's groups were last saved, and `group_checks_at` when they were first checked.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.list_saves
  add column groups_at timestamptz,
  add column group_checks_at timestamptz;
