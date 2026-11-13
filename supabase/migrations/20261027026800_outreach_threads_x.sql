-- =============================================================================
-- Social Outreach: Threads and X join the networks (docs/outreach.md decision 163).
--
-- Chris (13 Nov 2026): "I want to add Threads and X to the social media outreach ... these should search often for
-- new posts related to our niche and comment on them as the main activity". Both are follow networks, as Instagram
-- is: every table that names a network takes `threads` and `x` beside the four there are, and `computers.allowed`,
-- the networks Chrome lets the extension on, may name them too.
--
-- Only widens: nothing already saved changes.
-- =============================================================================

alter table addon_outreach.asks drop constraint asks_platform_check,
  add constraint asks_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.autopilot_people drop constraint autopilot_people_platform_check,
  add constraint autopilot_people_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.days drop constraint days_platform_check,
  add constraint days_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.file_chats drop constraint file_chats_platform_check,
  add constraint file_chats_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.file_people drop constraint file_people_platform_check,
  add constraint file_people_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.finds drop constraint finds_platform_check,
  add constraint finds_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.groups drop constraint groups_platform_check,
  add constraint groups_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.helpful drop constraint helpful_platform_check,
  add constraint helpful_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.imports drop constraint imports_platform_check,
  add constraint imports_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.network_starts drop constraint network_starts_platform_check,
  add constraint network_starts_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.partner_leads drop constraint partner_leads_platform_check,
  add constraint partner_leads_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.partner_searches drop constraint partner_searches_platform_check,
  add constraint partner_searches_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.profiles drop constraint profiles_platform_check,
  add constraint profiles_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.request_pauses drop constraint request_pauses_platform_check,
  add constraint request_pauses_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.tallies drop constraint tallies_platform_check,
  add constraint tallies_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.threads drop constraint threads_platform_check,
  add constraint threads_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));
alter table addon_outreach.warnings drop constraint warnings_platform_check,
  add constraint warnings_platform_check
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x'));

alter table addon_outreach.computers drop constraint computers_allowed_check,
  add constraint computers_allowed_check
    check (allowed is null or allowed <@ array['facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x']);
