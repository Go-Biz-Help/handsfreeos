-- =============================================================================
-- Social Outreach: each network's own profile in Get ready (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
-- "Each network on its own"; docs/outreach.md).
--
--        `setup.network_profiles` is each other network's profile in Get ready, as `profile` and `profile_check`
--        beside it are Facebook's: the items ticked and the AI's latest check, by network
--        (`{"linkedin": {"ticks": {...}, "check": {...}}}`). LinkedIn's profile has its headline and About, and a
--        LinkedIn day waits on LinkedIn's profile, never on Facebook's.
--
-- Only adds: one column with a default, so every setup kept reads as Facebook's alone, as before.
-- =============================================================================

alter table addon_outreach.setup
  add column network_profiles jsonb not null default '{}'::jsonb
    check (jsonb_typeof(network_profiles) = 'object');
