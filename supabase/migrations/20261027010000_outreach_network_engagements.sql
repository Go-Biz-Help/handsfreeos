-- =============================================================================
-- Social Outreach: warm leads from the network itself
-- (HANDSFREEOS_INSTAGRAM_ALIGNABLE_IMPLEMENTATION_PLAN.md, Alignable's "Where the
-- people are", 5: "Whoever likes, comments on or recommends you: warm leads").
--
--        Until now someone who engaged did it with one of the person's
--        helpful posts (`helpful_id`). On Alignable the extension also reads
--        the person's notifications: who liked or commented on their posts
--        and answers, and who recommended them. Those aren't tied to a
--        helpful post, so `helpful_id` may be empty, and `recommend` is a
--        kind of its own, only ever from the network.
--
--        `engagements_network_key` keeps one row a person and kind off any
--        helpful post, the latest seen.
--
-- Only widens: a column that may be empty, a kind more, a check and an index.
-- =============================================================================

alter table addon_outreach.engagements
  alter column helpful_id drop not null,
  drop constraint engagements_kind_check,
  add constraint engagements_kind_check check (kind in ('comment', 'reaction', 'recommend')),
  add constraint engagements_recommend_check check (kind <> 'recommend' or helpful_id is null);

create unique index engagements_network_key
  on addon_outreach.engagements (workspace_id, user_id, profile_id, kind)
  where helpful_id is null;
