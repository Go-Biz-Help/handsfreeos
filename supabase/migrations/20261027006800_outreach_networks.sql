-- =============================================================================
-- Social Outreach: LinkedIn joins the networks, and each network keeps its own day
-- (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Each network on its own"; docs/outreach.md).
--
-- Chris's rule (2026-10-15): a warning or a pause on one network never affects the others. A warning already says
-- which network showed it; the day didn't, so Stop for today and a warning's stop were one for every network.
--
--        The seven tables that name a network (profiles, threads, groups, imports, file_people, file_chats,
--        warnings) take `linkedin` beside `facebook`. Nothing reads or saves a LinkedIn page yet: the extension
--        only works on Facebook, and the app offers no network but Facebook.
--
--        `days.platform` is the network a day is for: Start my day, Stop for today and a warning's stop are each
--        network's. Every day kept is Facebook's.
--
-- Only adds and widens: the old one-day-a-person key (`days_workspace_id_user_id_key`) stays until the code that
-- keys a day by its network is deployed, since the code running now names it in `on conflict`. A later migration
-- drops it; until then a person has one day row, which is Facebook's.
-- =============================================================================

alter table addon_outreach.profiles drop constraint profiles_platform_check,
  add constraint profiles_platform_check check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.threads drop constraint threads_platform_check,
  add constraint threads_platform_check check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.groups drop constraint groups_platform_check,
  add constraint groups_platform_check check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.imports drop constraint imports_platform_check,
  add constraint imports_platform_check check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.file_people drop constraint file_people_platform_check,
  add constraint file_people_platform_check check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.file_chats drop constraint file_chats_platform_check,
  add constraint file_chats_platform_check check (platform in ('facebook', 'linkedin'));
alter table addon_outreach.warnings drop constraint warnings_platform_check,
  add constraint warnings_platform_check check (platform in ('facebook', 'linkedin'));

-- A warning is looked up by its network: the latest one on that network for the person.
create index warnings_user_platform_at_idx on addon_outreach.warnings (workspace_id, user_id, platform, at desc);

alter table addon_outreach.days
  add column platform text not null default 'facebook' check (platform in ('facebook', 'linkedin'));
create unique index days_user_platform_idx on addon_outreach.days (workspace_id, user_id, platform);
