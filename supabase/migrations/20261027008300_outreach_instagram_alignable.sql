-- =============================================================================
-- Social Outreach: Instagram and Alignable join the networks (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
-- build order 6; docs/outreach.md decision 78).
--
-- Chris (17 Oct 2026): "add instagram and alignable as platforms". Each starts with a look at a real account: the
-- extension only reads its pages for Check Instagram and Check Alignable, and its steps are built from what that reads.
--
--        Every table that names a network (profiles, threads, groups, imports, file_people, file_chats, warnings,
--        days, asks, helpful and the old reports) takes `instagram` and `alignable` beside `facebook` and `linkedin`;
--        and `computers.allowed`, the networks Chrome lets the extension on as each beat says, may name them too.
--
-- Only widens: nothing is written on either network yet but asks (Check), warnings and what a computer says it's
-- allowed on.
-- =============================================================================

alter table addon_outreach.profiles drop constraint profiles_platform_check,
  add constraint profiles_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.threads drop constraint threads_platform_check,
  add constraint threads_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.groups drop constraint groups_platform_check,
  add constraint groups_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.imports drop constraint imports_platform_check,
  add constraint imports_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.file_people drop constraint file_people_platform_check,
  add constraint file_people_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.file_chats drop constraint file_chats_platform_check,
  add constraint file_chats_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.warnings drop constraint warnings_platform_check,
  add constraint warnings_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.days drop constraint days_platform_check,
  add constraint days_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.asks drop constraint asks_platform_check,
  add constraint asks_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.helpful drop constraint helpful_platform_check,
  add constraint helpful_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));
alter table addon_outreach.reports drop constraint reports_platform_check,
  add constraint reports_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable'));

alter table addon_outreach.computers drop constraint computers_allowed_check,
  add constraint computers_allowed_check
    check (allowed is null or allowed <@ array['facebook', 'linkedin', 'instagram', 'alignable']);
