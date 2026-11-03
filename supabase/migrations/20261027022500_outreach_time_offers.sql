-- =============================================================================
-- Social Outreach: times to meet, offered in the chat, and booked before the
-- reply goes (docs/outreach.md, decision 149).
--
-- The owner's decision (3 Nov 2026, "1a 2a 3a 4a"): when a playbook's link is
-- one of the business's own booking pages, Send the link, the follow-up after
-- it, Offer another time and a reply that leads to a call offer three open
-- times on that calendar (the person's own when they're on it), with the link
-- kept for any other time. When the prospect picks one and gives an email or a
-- mobile number, the reply confirms it, and the booking is made just before
-- that reply goes, through the person's demo link.
--
--        `time_offers` keeps, for each drafted message that offers times or
--        books one: the calendar, whose times they are (`host_user_id`), the
--        times offered and the booking to make, the drafts it was written
--        for, and once it's queued, the message it goes with (`send_id`).
--        An OK'd message waits while its times are checked again and its
--        booking made (`state` drafted or checking), then goes (ready or
--        booked); one whose time was taken is written again (taken).
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.time_offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  calendar_id uuid not null references app.calendars (id) on delete cascade,
  -- Whose times they are (3a): the person's own, when they're on that calendar; null for anyone on it.
  host_user_id uuid references app.users (id) on delete set null,
  -- Their time zone, as the times were worked out in.
  zone text not null,
  -- The times offered: [{ at, says, sessionId }].
  times jsonb not null default '[]'::jsonb,
  -- The booking to make before the message goes: { at, says, sessionId, name, email, phone }.
  booking jsonb,
  -- The drafts it was written for: the one queued takes it.
  drafts text[] not null default '{}',
  -- The message it goes with, once the extension queued one of the drafts.
  send_id uuid,
  state text not null default 'drafted'
    check (state in ('drafted', 'checking', 'ready', 'booked', 'taken', 'failed', 'dropped')),
  -- The person OK'd it themselves (not on its own): written again, it waits for them again.
  approved_by_person boolean not null default false,
  -- How many times its message was written again after a time in it was taken.
  redrafts integer not null default 0,
  appointment_id uuid references app.appointments (id) on delete set null,
  why text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index time_offers_profile_idx on addon_outreach.time_offers (workspace_id, user_id, profile_id, created_at desc);
create unique index time_offers_send_idx on addon_outreach.time_offers (send_id) where send_id is not null;
select private.addon_table_policies('addon_outreach.time_offers', 'outreach.use', 'outreach.use', null, null);

-- Each person's are their own: they and the business's managers read them, and only they write theirs.
create policy time_offers_own_read on addon_outreach.time_offers as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'outreach.manage'));
create policy time_offers_own_insert on addon_outreach.time_offers as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy time_offers_own_update on addon_outreach.time_offers as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
