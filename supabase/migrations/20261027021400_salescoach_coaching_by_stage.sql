-- =============================================================================
-- AI Sales Coach: coaching by stage on a live call
-- (docs/salescoach.md, "The question-led method"; round five, part two).
--
-- The owner's decision (2026-10-31, "all of your picks"): live coaching shows
-- the stage the call is in, the next question fitted to what the customer
-- said, a tip on how to say it, and a nudge when the rep strays from the
-- method (pitching before the problem, talking over the customer, skipping a
-- stage).
--
-- A card gains its tip, and a nudge is a new kind of card. Nothing else here
-- changes: the stage comes from the playbook's steps, and the score's stages
-- live in the call's write-up.
-- =============================================================================

alter table addon_salescoach.cards
  add column tip text not null default '' check (length(tip) <= 120);

alter table addon_salescoach.cards drop constraint cards_kind_check;
alter table addon_salescoach.cards add constraint cards_kind_check
  check (kind in ('objection', 'fact', 'step', 'question', 'nudge'));
