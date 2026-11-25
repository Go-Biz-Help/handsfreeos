-- =============================================================================
-- Social Outreach: where each person's day is up to, so the app can show the plan (docs/outreach.md, decision 195).
--
-- The owner's decision (settled, 25 Nov 2026): the web and phone apps hold the schedule, and the extension does
-- what it's sent. This is the first step: the plan shows on Today. The extension still works its day out itself,
-- with the same rules, which now live in @hfos/core, and tells HandsFreeOS where its day is up to. HandsFreeOS
-- works out the rest of the day from that.
--
--        `plan_days` keeps, for each person and network, the last thing their working computer said of its day:
--        what's done, what was tried, what waits to be looked at again and when it next works (`state`), and when
--        it said so (`noted_at`). One row a person and network, their own. It holds no message and nobody's words.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.plan_days (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null
    check (platform in ('facebook', 'linkedin', 'instagram', 'alignable', 'threads', 'x')),
  day date not null,
  state jsonb not null,
  noted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform)
);
select private.addon_table_policies('addon_outreach.plan_days', 'outreach.use', 'outreach.use', null, null);

-- Each person's rows are their own: nobody else reads or writes where their day is up to.
create policy plan_days_own on addon_outreach.plan_days as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Nor does a view of someone show it (20261027032800: a person's own things stay theirs).
create policy plan_days_not_viewed on addon_outreach.plan_days as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));
