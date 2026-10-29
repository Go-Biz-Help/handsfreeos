-- =============================================================================
-- Social Outreach: a helpful post once a week on Instagram and Alignable
-- (docs/outreach.md, decision 109).
--
-- The owner's decision (settled):
--
--        Once a week each. On Instagram the AI writes the caption and says
--        what picture to take, and you post it from your phone. On Alignable
--        the extension posts it after your OK.
--
-- `helpful.picture` keeps the picture to take for an Instagram post, in one
-- line. The helpful posts' networks were allowed already
-- (20261027008300_outreach_instagram_alignable.sql).
--
-- Only adds a column.
-- =============================================================================

alter table addon_outreach.helpful
  add column picture text check (picture is null or length(btrim(picture)) between 1 and 300);
