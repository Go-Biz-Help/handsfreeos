-- =============================================================================
-- AI Sales Coach, round two: written conversations written up once they go
-- quiet (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, docs/salescoach.md).
--
--        A coached record was always one of core's calls. Now it can be a
--        stretch of a written conversation instead (a text thread, a chat,
--        Messenger, Instagram or email), written up the same way once nobody
--        has written for a while: the notes on the customer's timeline, a
--        follow-up, a task for each promise and a score (Chris, 2026-10-14).
--        Exactly one of the call and the conversation is set. A conversation
--        has one write-up per stretch, ending at `through_message_id`.
-- =============================================================================

alter table addon_salescoach.calls
  alter column call_id drop not null,
  add column conversation_id uuid references app.conversations (id) on delete cascade,
  add column through_message_id uuid references app.messages (id) on delete set null,
  -- The channel of a written conversation's write-up (sms, email…); null for a call.
  add column channel text check (channel is null or channel in ('sms', 'email', 'chat', 'portal', 'messenger', 'instagram')),
  add constraint calls_call_or_conversation check (num_nonnulls(call_id, conversation_id) = 1),
  add constraint calls_channel_with_conversation check ((channel is null) = (conversation_id is null));

create unique index calls_conversation_through_idx on addon_salescoach.calls (conversation_id, through_message_id)
  where conversation_id is not null;
create index calls_conversation_idx on addon_salescoach.calls (conversation_id) where conversation_id is not null;
create index calls_through_message_idx on addon_salescoach.calls (through_message_id)
  where through_message_id is not null;
