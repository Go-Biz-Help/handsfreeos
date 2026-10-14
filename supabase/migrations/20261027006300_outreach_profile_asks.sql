-- Social Outreach: your profile, read by the extension and checked by the AI (docs/outreach.md, decision 64). Reading
-- the person's own profile, and putting the bio they picked in, are asks of their computer, so `asks` takes
-- `profile_read` and `profile_edit`.
--
-- Only adds: two kinds more that `asks` takes.

alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'lookup', 'checks', 'cancel', 'unfriend', 'group_checks', 'join', 'post',
  'research', 'profile_read', 'profile_edit'));
