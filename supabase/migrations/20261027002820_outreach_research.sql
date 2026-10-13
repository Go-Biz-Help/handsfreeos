-- Social Outreach: Research (docs/outreach.md, decision 46a). Pressing Research on someone is an ask of the person's
-- computer, so `asks` takes `research`.
--
-- Only adds: a kind more that `asks` takes.

alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'lookup', 'checks', 'cancel', 'unfriend', 'group_checks', 'join', 'post',
  'research'));
