-- =============================================================================
-- Social Outreach: comment research on every network (docs/outreach.md,
-- decision 172).
--
-- The owner's ask (settled, 16 Nov 2026):
--
--        The comment research is on Instagram; it should be on all the
--        platforms we have built.
--
-- The picks: one Start reads all six networks together, about 2,000 comments
-- on each over 3 days, and each network gets its own guide that staff put in
-- use on its own. A research and a guide already name their network
-- (`platform`), and one research reads at a time a network
-- (comment_research_open_idx) and one guide is in use a network
-- (comment_guides_in_use_idx): only the checks said Instagram alone.
--
-- Only widens two checks. Running code writes 'instagram' only, which both
-- still allow.
-- =============================================================================

alter table addon_outreach.comment_research drop constraint comment_research_platform_check;
alter table addon_outreach.comment_research add constraint comment_research_platform_check
  check (platform in ('instagram', 'facebook', 'linkedin', 'alignable', 'threads', 'x'));

alter table platform.comment_guides drop constraint comment_guides_platform_check;
alter table platform.comment_guides add constraint comment_guides_platform_check
  check (platform in ('instagram', 'facebook', 'linkedin', 'alignable', 'threads', 'x'));
