-- =============================================================================
-- Social Outreach: more from finding people by topic
-- (docs/outreach.md, decision 116).
--
-- The owner's decision (settled):
--
--        It likes a commenter's comment as the warm-up before following.
--        It reads up to 3 screens of a Likes box, and Alignable likers.
--        The 30 found checks a day becomes a business setting from 10 to
--        100. Activity shows which hashtags brought replies. Finds never
--        checked are tidied away after 14 days. Facebook group members get
--        the AI's check too.
--
-- A check of someone in one of the business's Facebook groups who isn't a
-- friend says so (`checks.via` takes `member`): it counts with the checks of
-- people the person knows, and shows with the people they know only once
-- they're friends.
--
-- Only adds: a check that lets one more kind.
-- =============================================================================

alter table addon_outreach.checks drop constraint checks_via_check;
alter table addon_outreach.checks add constraint checks_via_check
  check (via in ('known', 'found', 'follower', 'member'));
