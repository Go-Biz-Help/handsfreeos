-- =============================================================================
-- Social Outreach: who followed the person, as a warm lead
-- (HANDSFREEOS_INSTAGRAM_ALIGNABLE_IMPLEMENTATION_PLAN.md, Instagram's "Where the
-- people are", 1: "People engaging with you: new followers, likes and comments on
-- your posts").
--
--        On Instagram the extension reads the person's notifications for who
--        liked or commented on their posts and who started following them,
--        and sends them as warm leads (`outreach.engaged.save`), as Alignable's
--        are. A follow is a kind of its own, only ever from the network, off
--        any helpful post, as a recommendation is.
--
-- Only widens: a kind more, and a check.
-- =============================================================================

alter table addon_outreach.engagements
  drop constraint engagements_kind_check,
  add constraint engagements_kind_check
    check (kind in ('comment', 'reaction', 'recommend', 'follow')),
  add constraint engagements_follow_check check (kind <> 'follow' or helpful_id is null);
