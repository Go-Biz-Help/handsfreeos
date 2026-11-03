-- =============================================================================
-- Social Outreach: a group's members read further down each day
-- (docs/outreach.md, decision 148).
--
-- The owner's decision (3 Nov 2026, "1a 2a 3a 4a"): a person can pick Only the
-- groups I'm in on a network with groups, so nothing new is joined and the
-- groups they're already in are worked instead. For that to bring new people,
-- each once-a-day read of a group's members has to go further down its list
-- than the last one did, rather than reading its first screens again.
--
--        `my_groups.members_depth` keeps, for each person and group, how many
--        screens down their last read got. The next read scrolls past them and
--        saves what comes after. A list that ran out, or one read as deep as it
--        goes, sets it back to 0, so the next read starts at the top again.
--
-- Only adds: nothing is dropped or changed. Every row starts at 0, which reads
-- the same as today.
-- =============================================================================

alter table addon_outreach.my_groups
  add column members_depth integer not null default 0 check (members_depth >= 0);
