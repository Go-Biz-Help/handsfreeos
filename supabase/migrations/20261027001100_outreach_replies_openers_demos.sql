-- =============================================================================
-- Social Outreach (outreach): phone alerts, which openers work, and the demo
-- link (docs/outreach.md, decisions 22 to 24).
--
--        `replies` keeps each reply the extension saw in the person's chats on
--        Facebook: the last message is theirs, after a message of the
--        person's it noted. One per message of theirs it answers, so a chat
--        seen again is no news; a new one pushes to the person's phone.
--
--        `opener_uses` keeps which opener a first message to someone was
--        drafted with, as the person copied it: an AI style or one of the
--        business's own openers. One per person reached.
--
--        `demos` keeps the demos the people reached booked: through the
--        person's demo link, or marked by the person.
--
--        In core, `app.appointment_attendees.link_ref` keeps the `ref` a
--        booking page was opened with, for an online booking, so the demo
--        link's booking counts by itself. Nothing in core points into the
--        add-on: it reads the `ref` back when it hears of the booking.
-- =============================================================================

alter table app.appointment_attendees
  add column link_ref text check (link_ref is null or link_ref ~ '^[A-Za-z0-9_-]{1,64}$');

create table addon_outreach.replies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  thread_key text check (thread_key is null or thread_key ~ '^[0-9]{1,30}$'),
  -- The person's message it answers: their last one noted before it was seen.
  after_at timestamptz not null,
  seen_at timestamptz not null,
  pushed boolean not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id, after_at),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index replies_user_seen_idx on addon_outreach.replies (workspace_id, user_id, seen_at desc);
create index replies_profile_idx on addon_outreach.replies (profile_id);
select private.addon_table_policies('addon_outreach.replies', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.opener_uses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  playbook_id uuid,
  kind text not null check (kind in ('style', 'own')),
  text text not null check (length(text) between 1 and 600),
  used_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, playbook_id) references addon_outreach.playbooks (workspace_id, id) on delete set null (playbook_id)
);
create index opener_uses_playbook_idx on addon_outreach.opener_uses (workspace_id, playbook_id, used_at desc);
create index opener_uses_profile_idx on addon_outreach.opener_uses (profile_id);
select private.addon_table_policies('addon_outreach.opener_uses', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.demos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  how text not null check (how in ('link', 'marked')),
  -- A booking through the demo link: the appointment and the customer who booked.
  appointment_id uuid references app.appointments (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  at timestamptz not null,
  -- A mark the person took back: kept, and not counted. Marking again counts it from then.
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create unique index demos_appointment_idx on addon_outreach.demos (workspace_id, appointment_id, person_id)
  where appointment_id is not null;
create unique index demos_marked_idx on addon_outreach.demos (workspace_id, user_id, profile_id)
  where how = 'marked';
create index demos_user_idx on addon_outreach.demos (workspace_id, user_id, at desc);
create index demos_profile_idx on addon_outreach.demos (profile_id);
create index demos_person_idx on addon_outreach.demos (person_id) where person_id is not null;
select private.addon_table_policies('addon_outreach.demos', 'outreach.use', 'outreach.use', null, null);
