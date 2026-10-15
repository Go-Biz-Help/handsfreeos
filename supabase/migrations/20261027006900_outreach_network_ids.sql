-- =============================================================================
-- Social Outreach: ids in each network's own shape (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "The data").
--
-- The ids the extension reads off a page were checked as Facebook writes them: a profile's number, its username of
-- letters, numbers and dots, a chat's number. LinkedIn's member ids look like `ACoAA…`, its public profile names
-- have hyphens, and its conversations' ids end in `==`. Each network's exact shape is checked in code
-- (packages/core/src/addons/outreach/networks.ts, `profileMisfit`); the database keeps to short, plain characters.
--
-- Only widens: everything kept already fits, and the code running now writes nothing these refuse.
-- =============================================================================

alter table addon_outreach.profiles drop constraint profiles_platform_id_check,
  add constraint profiles_platform_id_check
    check (platform_id is null or platform_id ~ '^[A-Za-z0-9_-]{1,64}$');
alter table addon_outreach.profiles drop constraint profiles_username_check,
  add constraint profiles_username_check
    check (username is null or username ~ '^[A-Za-z0-9.%_-]{1,100}$');

alter table addon_outreach.threads drop constraint threads_thread_key_check,
  add constraint threads_thread_key_check check (thread_key ~ '^[A-Za-z0-9._=+-]{1,128}$');
alter table addon_outreach.touches drop constraint touches_thread_key_check,
  add constraint touches_thread_key_check
    check (thread_key is null or thread_key ~ '^[A-Za-z0-9._=+-]{1,128}$');
alter table addon_outreach.file_chats drop constraint file_chats_thread_key_check,
  add constraint file_chats_thread_key_check
    check (thread_key is null or thread_key ~ '^[A-Za-z0-9._=+-]{1,128}$');
alter table addon_outreach.replies drop constraint replies_thread_key_check,
  add constraint replies_thread_key_check
    check (thread_key is null or thread_key ~ '^[A-Za-z0-9._=+-]{1,128}$');
alter table addon_outreach.sends drop constraint sends_thread_key_check,
  add constraint sends_thread_key_check
    check (thread_key is null or thread_key ~ '^[A-Za-z0-9._=+-]{1,128}$');
