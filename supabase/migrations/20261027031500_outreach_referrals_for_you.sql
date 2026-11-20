-- =============================================================================
-- Social Outreach (outreach): referrals done for the person (docs/outreach.md,
-- decision 185; the owner's picks of 18 and 20 Nov 2026).
--
--        `referrals` gains `approved`: posted for the person by their
--        computer, under Autopilot or once they press Do it for me, on
--        Facebook. `posted_at` is when the comment went up there and
--        `tagged` whether it tagged them (else their name went as plain
--        words); `noted_at` is when the heads-up went to them; `needs` says
--        why one came back to the person. `note` may be empty now: the
--        heads-up goes to someone at most once a week, so a second referral
--        within the week is the comment alone.
--
--        `refer_asks` keeps the short note to someone referred twice that
--        asks if they'd send people the person's way too, or have a call,
--        written once the chat has been quiet three days: one a person, ever.
--        Waiting for the person, approved (sent for them), done or put aside.
--
-- Only adds: a check widened, a not null dropped, columns and a table.
-- =============================================================================

alter table addon_outreach.referrals drop constraint if exists referrals_state_check;
alter table addon_outreach.referrals
  add constraint referrals_state_check check (state in ('waiting', 'approved', 'done', 'skipped'));
alter table addon_outreach.referrals alter column note drop not null;
alter table addon_outreach.referrals
  add column if not exists posted_at timestamptz,
  add column if not exists tagged boolean,
  add column if not exists noted_at timestamptz,
  add column if not exists needs text check (needs is null or length(btrim(needs)) between 1 and 300);

create table addon_outreach.refer_asks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  text text not null check (length(btrim(text)) between 1 and 1000),
  state text not null default 'waiting' check (state in ('waiting', 'approved', 'done', 'skipped')),
  needs text check (needs is null or length(btrim(needs)) between 1 and 300),
  sent_at timestamptz,
  done_at timestamptz,
  skipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index refer_asks_user_idx on addon_outreach.refer_asks (workspace_id, user_id, created_at desc);
create index refer_asks_profile_idx on addon_outreach.refer_asks (profile_id);
select private.addon_table_policies('addon_outreach.refer_asks', 'outreach.use', 'outreach.use', null, null);
create policy refer_asks_own on addon_outreach.refer_asks as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
