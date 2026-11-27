-- =============================================================================
-- Social Outreach: what a person changed on today's plan (docs/outreach.md, decision 195, step 3).
--
-- The owner's decision (settled, 25 Nov 2026): the web and phone apps hold the schedule, and the extension does
-- what it's sent, "this way we could have the assistant tell the extension to do things or have buttons in the
-- app". Step 3 is the buttons on Today's Plan: Do now, Skip today, Move to a time, and Put back.
--
--        `plan_changes` keeps, for each person and network, the rows of today's plan they changed: which row
--        (`key`: a once-a-day read, or a step for someone on their list), what they said (`change`: put first,
--        skipped today, or moved to a time, `at`), when (`made_at`), and what the row said (`title`), so what was
--        skipped can be shown and put back. One a row of the plan, the newest change to it; a row from an earlier
--        day (`day`) counts for nothing and goes with the person's next change. Their own. It holds no message.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.plan_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x')),
  day date not null,
  key text not null check (char_length(key) between 1 and 320),
  change text not null check (change in ('now', 'skip', 'at')),
  at timestamptz,
  title text not null check (char_length(title) <= 200),
  made_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform, key),
  -- A move has its time, and nothing else has one.
  check ((change = 'at') = (at is not null))
);
-- A person takes their own change back (Put back), so they may delete here: the row is a note of a press, and
-- nothing else hangs off it.
select private.addon_table_policies(
  'addon_outreach.plan_changes', 'outreach.use', 'outreach.use', 'outreach.use', null);

-- Each person's rows are their own: nobody else reads, changes or takes back what they did to their day.
create policy plan_changes_own on addon_outreach.plan_changes as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Nor does a view of someone show it (20261027032800: a person's own things stay theirs).
create policy plan_changes_not_viewed on addon_outreach.plan_changes as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));
