-- =============================================================================
-- Social Outreach: birthday and new-job notes (docs/outreach.md, decision
-- 108).
--
-- The owner's decision (settled):
--
--        Only for people you've chatted with or who fit a playbook. The AI
--        drafts the note and it waits for your OK.
--
-- `occasions` keeps what the person's computer read on Facebook's Birthdays
-- page and LinkedIn's Catch up page, once a day: whose birthday it is, or who
-- started a new job, among the people already kept. Each person's own. Today
-- offers a note on the day (`on_day`, the business's), for a birthday that
-- day only, and for a new job for two weeks.
--
-- `addon_outreach.sends.kind` takes the two notes: `birthday` and `new_job`.
--
-- Only adds: a table, and a check that lets two more kinds.
-- =============================================================================

create table addon_outreach.occasions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  kind text not null check (kind in ('birthday', 'new_job')),
  -- The business's day it was read for: "2026-10-28".
  on_day date not null,
  -- For a new job, what the page said: "Started a new position as Owner at Reyes Plumbing".
  detail text check (detail is null or length(btrim(detail)) between 1 and 300),
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id, kind, on_day),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index occasions_user_idx on addon_outreach.occasions (workspace_id, user_id, on_day desc);
create index occasions_profile_idx on addon_outreach.occasions (profile_id);
select private.addon_table_policies('addon_outreach.occasions', 'outreach.use', 'outreach.use', null, null);
create policy occasions_own on addon_outreach.occasions as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in',
    'partner_ask', 'partner_follow_up', 'partner_details', 'partner_reply', 'comment',
    'demo_reminder', 'rebook', 'birthday', 'new_job'));
