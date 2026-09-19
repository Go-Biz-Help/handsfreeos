-- A conversation can be put away, the way a lead, a customer or a company can.
--
-- The inbox could close a conversation, which says "this needed nothing more" and is undone by the next message
-- arriving — there was no way to take a thread out of the inbox and keep it off (step 1, finding: "need to be able
-- to delete things like leads, pipeline entries, inbox conversations").
--
-- `archived_at` rather than another `status`: archiving is orthogonal to open/snoozed/closed, so a thread comes
-- back to exactly the state it was in, and it matches `archived_at` on leads, people and companies. Nothing is
-- deleted — the messages, calls and timeline entries stay, and the audit log keeps its trail.

alter table app.conversations add column archived_at timestamptz;

comment on column app.conversations.archived_at is
  'Set while the conversation is out of the inbox. Its status is untouched, so restoring brings back the open, snoozed or closed thread as it was. Only `records.archive` sets it (conversation.archive / conversation.restore).';

-- The inbox lists by (workspace, status, recency) and now skips archived rows; the partial index keeps that the
-- same cost it was, since all but a handful of rows have archived_at null.
create index conversations_live_idx on app.conversations (workspace_id, status, last_message_at desc)
  where archived_at is null;
