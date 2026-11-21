-- =============================================================================
-- Networking calls (docs/outreach.md, decision 187; the owner's picks 5a and 6a
-- of 20 Nov 2026): a call someone booked through the person's networking call
-- link, or on their Networking calendar under the name of someone they chat
-- with. Half an hour before it the person's phone gets a prep note; after it
-- a thank-you waits on Today for their OK; Today and Monday's push count them.
--
--        calls      one a booking and person: who it's with, how it was
--                   known, and the prep note pushed with the call's time then.
--        sends      takes the new kind 'thank_you'.
--
-- Only adds: a table with its policies, and a wider check.
-- =============================================================================

create table addon_outreach.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  person_id uuid references app.people (id) on delete set null,
  how text not null check (how in ('link', 'name')),
  prep text check (prep is null or length(btrim(prep)) between 1 and 700),
  prepped_at timestamptz,
  prepped_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, appointment_id, user_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index calls_user_idx on addon_outreach.calls (workspace_id, user_id, created_at desc);
create index calls_profile_idx on addon_outreach.calls (profile_id);
create index calls_appointment_idx on addon_outreach.calls (appointment_id);
create index calls_person_idx on addon_outreach.calls (person_id) where person_id is not null;
select private.addon_table_policies('addon_outreach.calls', 'outreach.use', 'outreach.use', null, null);
create policy calls_own on addon_outreach.calls as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in',
    'partner_ask', 'partner_follow_up', 'partner_details', 'partner_reply', 'comment',
    'demo_reminder', 'rebook', 'thank_you', 'birthday', 'new_job', 'group_reply'));
