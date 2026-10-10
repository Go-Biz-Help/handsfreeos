-- =============================================================================
-- Social Outreach (outreach): messages the extension sends on its own
-- (docs/outreach.md, decisions 26 and 27, and training wheels).
--
--        `sends` keeps each message the extension drafted to send for a
--        person: a first message, a follow-up or a reply, with the words the
--        AI wrote and the words that go, and where it stands: waiting for
--        the person's OK, OK'd, sent, skipped, or not sent. One open
--        (waiting or OK'd) a person, profile and kind at a time.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  kind text not null check (kind in ('opener', 'follow_up', 'reply')),
  chat_id uuid,
  thread_key text check (thread_key is null or thread_key ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- The words that go, and the AI's as it drafted them: a change before the OK teaches it.
  text text not null check (char_length(text) between 1 and 2000),
  drafted text not null check (char_length(drafted) between 1 and 2000),
  -- For a first message: the opener it was drafted with (decision 23).
  opener jsonb,
  state text not null default 'waiting'
    check (state in ('waiting', 'approved', 'sent', 'skipped', 'failed')),
  -- Why it wasn't sent, in the extension's words.
  why text check (why is null or char_length(why) <= 300),
  approved_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, chat_id) references addon_outreach.file_chats (workspace_id, id)
    on delete set null (chat_id)
);
create unique index sends_open_idx on addon_outreach.sends (workspace_id, user_id, profile_id, kind)
  where state in ('waiting', 'approved');
create index sends_user_state_idx on addon_outreach.sends (workspace_id, user_id, state, created_at desc);
create index sends_profile_idx on addon_outreach.sends (profile_id);
create index sends_chat_idx on addon_outreach.sends (chat_id);
select private.addon_table_policies('addon_outreach.sends', 'outreach.use', 'outreach.use', null, null);
