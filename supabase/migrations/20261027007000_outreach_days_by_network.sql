-- =============================================================================
-- Social Outreach: a person's day on each network, side by side (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
-- "Each network on its own").
--
-- 20261027006800 gave each day its network and a key of one a person and network (`days_user_platform_idx`), and
-- kept the old one-a-person key for the code that named it. That code is gone, so the old key goes: a person's
-- LinkedIn day can now be kept beside their Facebook one, and stopping one leaves the other going.
-- =============================================================================

alter table addon_outreach.days drop constraint days_workspace_id_user_id_key;
