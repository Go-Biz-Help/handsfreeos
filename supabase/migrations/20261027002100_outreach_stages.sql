-- =============================================================================
-- Social Outreach (outreach): stages, and the moment to pitch
-- (docs/outreach.md, decision 47).
--
--        Each person reached has a stage, worked out from what HandsFreeOS
--        knows: found, warming up, friends, talking, ready to pitch,
--        pitched, booked, or not a fit. Most of it is there already (the
--        steps noted, friends, chats, demos). What isn't is kept here:
--
--        `file_chats.pitch` is the AI's read of whether it's time to offer
--        the business's offer: `ready`, `not_yet`, or `not_interested`, with
--        why in a line. Chats read before this have none.
--
--        `stages` keeps, for one teammate and one profile, what the person
--        or the AI said beyond that: marked ready to pitch, or not a fit
--        (`mark`, by the person or by the AI's read of a chat that said no),
--        and when the pitch went (`pitched_at`: a pitch message sent, a
--        pitch draft copied, or marked). "Back in play" clears them. A
--        person's own mark is never undone by the AI; the AI's not a fit is
--        undone by its next read that says otherwise. Each person's own:
--        a restrictive policy keeps each request to its own rows.
--
--        A pitch message goes through `sends` like the rest, so its kinds
--        take `pitch` too.
--
-- Only adds: two columns, a new table, and a kind more that `sends` takes.
-- =============================================================================

alter table addon_outreach.file_chats
  add column pitch text check (pitch in ('ready', 'not_yet', 'not_interested')),
  add column pitch_why text check (pitch_why is null or length(btrim(pitch_why)) between 1 and 160);
create index file_chats_pitch_idx on addon_outreach.file_chats (workspace_id, user_id)
  where pitch = 'ready';

create table addon_outreach.stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  mark text check (mark in ('ready', 'lost')),
  marked_by text check (marked_by in ('person', 'ai')),
  why text check (why is null or length(btrim(why)) between 1 and 160),
  marked_at timestamptz,
  pitched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  check ((mark is null) = (marked_by is null) and (mark is null) = (marked_at is null)),
  check (mark is not null or why is null),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index stages_user_idx on addon_outreach.stages (workspace_id, user_id);
create index stages_profile_idx on addon_outreach.stages (profile_id);
select private.addon_table_policies('addon_outreach.stages', 'outreach.use', 'outreach.use', null, null);
create policy stages_own on addon_outreach.stages as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch'));
