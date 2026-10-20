-- =============================================================================
-- Social Outreach: a recommendation on Alignable, as a step noted
-- (HANDSFREEOS_INSTAGRAM_ALIGNABLE_IMPLEMENTATION_PLAN.md, question 8, "Recommend:
-- only by hand"; HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 6, part 3d).
--
--        Today suggests a customer or a partner to recommend, and the person
--        writes the recommendation on Alignable themselves. The extension
--        notes it once it's sent, as it notes a connection request or a
--        message, so Today stops suggesting them.
--
--        `touches` takes `recommend`.
--
-- Only widens a check.
-- =============================================================================

alter table addon_outreach.touches
  drop constraint touches_kind_check,
  add constraint touches_kind_check
    check (kind in ('friend_request', 'like', 'comment', 'message', 'recommend'));
