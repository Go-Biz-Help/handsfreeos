-- =============================================================================
-- Social Outreach: each network's own choices and training wheels (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
-- Chris's decisions of 2026-10-15: the same choices as Facebook, each network's own; each person turns networks on).
--
--        `automation.networks` is which networks the person works, and each other network's own choices of what
--        the extension does there on its own (sending, replies, liking a post first, confirming requests, the
--        once-a-day jobs, joining groups, watching for posts, helpful posts). Facebook's stay the columns they were.
--        Read with the defaults filling in what's left out: Facebook on, every other network off.
--
--        `automation.network_wheels` is each other network's training wheels, as the wheels columns are Facebook's:
--        a warning on LinkedIn puts LinkedIn's back on and leaves Facebook's be.
--
-- Only adds: two columns with defaults, so every row kept reads as before.
-- =============================================================================

alter table addon_outreach.automation
  add column networks jsonb not null default '{}'::jsonb
    check (jsonb_typeof(networks) = 'object'),
  add column network_wheels jsonb not null default '{}'::jsonb
    check (jsonb_typeof(network_wheels) = 'object');
