-- =============================================================================
-- AI Sales Coach, round two: replies to suggest in written conversations
-- (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, docs/salescoach.md).
--
--        When a customer writes (a text, Messenger, Instagram, the website
--        chat or an email) and no AI teammate is answering the conversation,
--        the worker asks the AI for two or three replies a person could send,
--        and keeps the newest set here, one per conversation. The web shows
--        them above the message box; a click puts one in the box to edit, and
--        nothing is ever sent from here (Chris, 2026-10-14).
--
--        **Who sees them:** anyone with `salescoach.use` who can see the
--        conversation (its own row security decides). Only the worker writes.
-- =============================================================================

create table addon_salescoach.suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  -- The customer's message they answer: once anyone replies after it, they're stale.
  message_id uuid not null references app.messages (id) on delete cascade,
  -- Two or three: each a short label and the words.
  replies jsonb not null
    check (jsonb_typeof(replies) = 'array' and jsonb_array_length(replies) between 1 and 3
           and octet_length(replies::text) <= 20000),
  -- The playbook's objection they answer, when the customer raised one.
  objection_id text check (objection_id is null or objection_id ~ '^o[0-9]{1,3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (conversation_id)
);
create index suggestions_workspace_idx on addon_salescoach.suggestions (workspace_id);
create index suggestions_message_idx on addon_salescoach.suggestions (message_id);
select private.addon_table_policies('addon_salescoach.suggestions', 'salescoach.use', 'salescoach.use', null, null);
-- Seen only with the conversation itself; written only by the worker.
create policy suggestions_with_conversation on addon_salescoach.suggestions as restrictive for select
  to authenticated
  using (exists (select 1 from app.conversations c where c.id = conversation_id));
create policy suggestions_worker_insert on addon_salescoach.suggestions as restrictive for insert
  to authenticated with check (false);
create policy suggestions_worker_update on addon_salescoach.suggestions as restrictive for update
  to authenticated using (false);
