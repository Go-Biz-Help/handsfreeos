-- =============================================================================
-- HandsFreeOS video calls: every call's chat is kept
-- (docs/video-calls.md, "The chat, kept"; the owner's pick of 3 November 2026, "Kept on every call").
--
--        The owner asked for HandsFreeOS to get what people type in a
--        call's chat as well as what they say, and picked: the chat is
--        saved for every call, even with AI notes off, and the AI uses it
--        when the notes are on.
--
--        - **Each message is a row**, from the screen that sent it: the
--          worker keeps it only from the ticket that screen joined on, so a
--          message is always its sender's own.
--        - **Kept with the call**, shown with it on the appointment (or on
--          the call's own line on the timeline), whatever its AI notes.
--          Deleting a customer takes their messages with their part of the
--          call; nothing else deletes them.
--        - **The AI's notes take them in once:** when a stretch of the call
--          is over, the messages sent in it go into its transcript beside
--          what was said ("Dana (in the chat): …"), while the call's AI
--          notes are on, and are marked with that stretch either way.
--
-- Only widens: a new table that only the worker writes.
-- =============================================================================

create table app.video_call_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  video_call_id uuid not null,
  -- Who sent it: their row of the call's people. Deleting a customer takes their part of the call, this included.
  person_row_id uuid not null references app.video_call_people (id) on delete cascade,
  -- The team's side or the customer's (anyone let in counts as the customer's), and the name the call showed.
  side text not null check (side in ('team', 'customer')),
  name text not null check (length(name) between 1 and 120),
  body text not null check (length(body) between 1 and 4000),
  sent_at timestamptz not null,
  -- LiveKit's id for the message, from the screen that sent it, so a report sent twice keeps one copy.
  message_key text not null check (length(message_key) between 1 and 100),
  -- The stretch of the call (LiveKit's room id) whose end took it into the AI's notes; null until that stretch is
  -- over. Each message is taken once, by the stretch it was sent in.
  stretch text check (stretch is null or length(stretch) between 1 and 100),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, video_call_id) references app.video_calls (workspace_id, id) on delete cascade,
  unique (video_call_id, person_row_id, message_key)
);
create index video_call_messages_call_idx on app.video_call_messages (video_call_id, sent_at);
create index video_call_messages_workspace_idx on app.video_call_messages (workspace_id);
create index video_call_messages_person_idx on app.video_call_messages (person_row_id);

comment on table app.video_call_messages is
  'What people typed in a HandsFreeOS video call''s chat, kept with the call whatever its AI notes, and taken into its transcript while they''re on.';

-- The same check as the lines': the sender is one of this call's people, in this business.
create trigger video_call_messages_check_refs before insert or update on app.video_call_messages
  for each row execute function private.check_video_call_line_refs();

-- Whoever can see the call (and the person who sent it) can read the chat; only the worker writes it.
alter table app.video_call_messages enable row level security;

create policy video_call_messages_select on app.video_call_messages for select to authenticated
  using (video_call_id in (select c.id from app.video_calls c)
    and person_row_id in (select p.id from app.video_call_people p));
create policy video_call_messages_service_all on app.video_call_messages for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.video_call_messages to authenticated;
grant select, insert, update, delete on app.video_call_messages to service_actor;
revoke all on app.video_call_messages from anon;
