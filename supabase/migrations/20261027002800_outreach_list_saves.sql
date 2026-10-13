-- =============================================================================
-- Social Outreach: the person's own lists, saved before their day (docs/outreach.md, "Lists first").
--
-- The owner's decision (settled): first day only. The first time, Start my day waits until the person's friends list,
-- the friend requests they've got and the ones they've sent are each saved to their end. After that, the requests are
-- saved again each morning before the day, and the friends list once a week.
--
--        `list_saves` keeps, for each person, when each list was last saved to its end, and when the first Tidy up
--        suggestions and good-fits check after that were done. One row a person, their own.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.list_saves (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  friends_at timestamptz,
  requests_at timestamptz,
  sent_at timestamptz,
  tidy_at timestamptz,
  checks_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id)
);
select private.addon_table_policies('addon_outreach.list_saves', 'outreach.use', 'outreach.use', null, null);

-- Each person's rows are their own: nobody else reads or writes when their lists were saved.
create policy list_saves_own on addon_outreach.list_saves as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
