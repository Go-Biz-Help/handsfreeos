-- =============================================================================
-- AI Social Media Content Creator: Threads and X join the networks (decision 41 in
-- HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md).
--
-- Chris (13 Nov 2026): "I want to add Threads and X to the social media outreach and social media content creator add
-- ons". Every table that names a network takes `threads` and `x` beside the five there are, and a business may pick
-- all seven.
--
-- `content.chain` is the posts that go under the first one when a tip runs longer than one post takes (an X thread, or
-- Threads' "Add to thread"): at most four, only on Threads and X, empty everywhere else.
--
-- Only widens and adds: nothing already saved changes.
-- =============================================================================

alter table addon_socialcontent.creators drop constraint creators_network_check,
  add constraint creators_network_check
    check (network in ('instagram', 'facebook', 'linkedin', 'threads', 'x', 'tiktok', 'youtube'));
alter table addon_socialcontent.work drop constraint work_network_check,
  add constraint work_network_check
    check (network in ('instagram', 'facebook', 'linkedin', 'threads', 'x', 'tiktok', 'youtube'));
alter table addon_socialcontent.ideas drop constraint ideas_network_check,
  add constraint ideas_network_check
    check (network is null
      or network in ('instagram', 'facebook', 'linkedin', 'threads', 'x', 'tiktok', 'youtube'));
alter table addon_socialcontent.content drop constraint content_network_check,
  add constraint content_network_check
    check (network in ('instagram', 'facebook', 'linkedin', 'threads', 'x', 'tiktok', 'youtube'));
alter table addon_socialcontent.settings drop constraint settings_networks_check,
  add constraint settings_networks_check
    check (networks <@ array['instagram', 'facebook', 'linkedin', 'threads', 'x', 'tiktok', 'youtube']
      and cardinality(networks) <= 7);

alter table addon_socialcontent.content
  add column chain text[] not null default '{}',
  add constraint content_chain_check check (cardinality(chain) <= 4);
