-- Social Outreach: a draft that waits for the person's OK goes once the chat moves on (docs/outreach.md, decision 134).
-- Someone wrote since it was drafted, either of them, so it answers where the chat was, not where it is: a reply that
-- pitched someone who has said no since, or a reply to a message the person answered themselves.
-- `outreach.chats.collect` deletes it as the person whose chat it is, and the next look drafts again from the chat as
-- it is now. Only their own, and only one never OK'd: what was OK'd, sent, skipped or not sent stays. Only adds: the
-- running code never deletes one until it's deployed.

grant delete on addon_outreach.sends to authenticated;
create policy sends_delete on addon_outreach.sends for delete to authenticated
  using (workspace_id in (select private.workspaces_with_permission('outreach.use')));
create policy sends_own_waiting_delete on addon_outreach.sends as restrictive for delete to authenticated
  using (user_id = (select auth.uid()) and state = 'waiting');
