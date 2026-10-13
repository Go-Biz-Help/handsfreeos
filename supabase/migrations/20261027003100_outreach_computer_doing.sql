-- =============================================================================
-- Social Outreach: which step before the first day a computer is doing (docs/outreach.md, "Lists first", the live
-- checklist).
--
-- The extension says, with each beat, the step under way before the person's first day (save the friends list, the
-- requests got and sent, the groups; check the groups; work out who to unfriend; check friends for good fits). The
-- web and the phone then show its count ("Reading your friends… 412 friends so far.") under that step and no other,
-- and a beat while one runs tells the app every few seconds rather than every 45.
--
--        `doing` is that step, or null while it does anything else.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.computers
  add column doing text
    check (doing is null or doing in ('friends', 'requests', 'sent', 'groups', 'group_checks', 'tidy', 'checks'));
