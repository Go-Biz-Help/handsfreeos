-- =============================================================================
-- Social Outreach: growing on LinkedIn (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part"
-- item 6; docs/outreach.md).
--
--        A post found by LinkedIn's post search (`found = 'search'`) is in no group, as `posts.group_id` already
--        allows.
--
--        `helpful.platform` is the network a helpful post goes up on. On LinkedIn it goes on the person's own feed,
--        which reaches their connections and followers, so it's in no group: `group_id` may be null there, never on
--        Facebook, where every helpful post is in one of the person's groups.
--
-- Only widens: a kind more that `found` takes, a column with a default, and a group a helpful post off Facebook
-- needn't have. Every helpful post kept reads as Facebook's, in its group, as before.
-- =============================================================================

alter table addon_outreach.posts drop constraint posts_found_check;
alter table addon_outreach.posts add constraint posts_found_check
  check (found in ('scroll', 'find', 'watch', 'search'));

alter table addon_outreach.helpful
  add column platform text not null default 'facebook' check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.helpful alter column group_id drop not null;
alter table addon_outreach.helpful
  add constraint helpful_group_on_facebook_check check (platform <> 'facebook' or group_id is not null);
