-- =============================================================================
-- Social Outreach: each network's own asks and lists (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Each
-- network on its own").
--
--        `asks.platform` is the network an ask is on. A LinkedIn ask is named by its network in its target, so it
--        never answers a Facebook one; a warning on one network ends only that network's asks; and a build of the
--        extension older than a network's first never takes one there.
--
--        `list_saves.network_saves` is when each other network's lists were saved to their end and its first-day
--        steps done, as the columns beside it are Facebook's. LinkedIn's first day waits on its connections and its
--        invitations either way, not on Facebook's lists.
--
-- Only adds: two columns with defaults, so every ask and list kept reads as Facebook's, as before.
-- =============================================================================

alter table addon_outreach.asks
  add column platform text not null default 'facebook' check (platform in ('facebook', 'linkedin'));

alter table addon_outreach.list_saves
  add column network_saves jsonb not null default '{}'::jsonb
    check (jsonb_typeof(network_saves) = 'object');
