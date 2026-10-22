-- Social Outreach: checking usernames are free (docs/outreach.md, decision 84). The person's computer opens each
-- username's address on the network and says whether anyone's there, before a new one is put in. One more kind of
-- ask; nothing else changes, and the running code never asks for it until it's deployed.

alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'lookup', 'checks', 'cancel', 'unfriend', 'group_checks', 'join', 'post',
  'research', 'profile_read', 'profile_edit', 'checkup', 'username_check'));
