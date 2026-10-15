-- =============================================================================
-- Social Outreach (outreach): the conversation, after a warm-up
-- (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, "The conversation";
-- docs/outreach.md, decisions 65 to 68).
--
--        Once someone accepts, the first message asks straight out whether
--        they'd be open to the main offer's outcome on its guarantee. A yes
--        gets the playbook's short video, then the booking link. Whoever
--        goes quiet gets follow-ups, 5 to 7 at the playbook's pace, then a
--        check-in once a month, until they answer or say no.
--
--        `follow_ups` keeps, for one teammate and one profile, where that
--        conversation is: the last step sent (the first message, the video,
--        the link), how many follow-ups have gone since, when the last
--        message went and when the next is due (or a check-in, after the
--        last follow-up), their latest answer as the AI read it (yes, a
--        question, later, no) and when, and the main offer's version they
--        were first pitched with: follow-ups and answers to them keep that
--        version's words. A no, or the business marking them not a fit,
--        stops it. Each person's own: a restrictive policy keeps each
--        request to its own rows.
--
--        `sends.offer_version` notes the version each message went with, and
--        `sends` takes two kinds more: `video` and `check_in`.
--        `file_chats.reply` is the chat read's answer to the person's last
--        step, and `stages.positive_at` when they first said yes: a positive
--        reply, counted on Results.
--
--        `setup.messages_at` and `messages_version` are when each person OK'd
--        how their messages read (Get ready's **Your messages**) and the main
--        offer's version then; `message_samples` the samples they saw, as
--        the AI wrote them, so the sheet opens without asking again.
--
-- Only adds: a new table, columns, and two kinds more that `sends` takes.
-- =============================================================================

create table addon_outreach.follow_ups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  step text not null check (step in ('first', 'video', 'link')),
  step_at timestamptz not null,
  sent smallint not null default 0 check (sent between 0 and 100),
  last_at timestamptz not null,
  next text check (next in ('follow_up', 'check_in')),
  due_at timestamptz,
  answer text check (answer in ('yes', 'question', 'later', 'no')),
  answered_at timestamptz,
  offer_version integer check (offer_version is null or offer_version >= 1),
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  check ((answer is null) = (answered_at is null)),
  check ((next is null) = (due_at is null)),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index follow_ups_due_idx on addon_outreach.follow_ups (workspace_id, user_id, due_at)
  where stopped_at is null;
create index follow_ups_profile_idx on addon_outreach.follow_ups (profile_id);
select private.addon_table_policies('addon_outreach.follow_ups', 'outreach.use', 'outreach.use', null, null);
create policy follow_ups_own on addon_outreach.follow_ups as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.sends
  add column offer_version integer check (offer_version is null or offer_version >= 1);
alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in'));

alter table addon_outreach.file_chats
  add column reply text check (reply in ('yes', 'question', 'later', 'no'));

alter table addon_outreach.stages
  add column positive_at timestamptz;

alter table addon_outreach.setup
  add column messages_at timestamptz,
  add column messages_version integer check (messages_version is null or messages_version >= 1),
  add column message_samples jsonb
    check (message_samples is null or (jsonb_typeof(message_samples) = 'object' and octet_length(message_samples::text) <= 16000));
