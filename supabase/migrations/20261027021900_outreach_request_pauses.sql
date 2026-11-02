-- =============================================================================
-- Social Outreach: a network's own monthly limit on the person's requests
-- (docs/outreach.md, decision 147).
--
-- The owner's decision (2 Nov 2026, "Pause requests till next month"):
-- Alignable lets an account send only so many connection requests a month,
-- then shows a box saying they've reached their monthly limit and asking them
-- to upgrade. When the extension sees it after Connect, new connection
-- requests there wait till the 1st of next month, with one line on Today
-- saying so. Likes, comments and messages keep going.
--
--        `request_pauses` keeps, for each person and network, till when new
--        requests wait (`until`), the network's own words, and when Start
--        again ended it sooner (`ended_at`, after an upgrade). One row a
--        person a network, written again each time.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.request_pauses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  words text[] not null,
  at timestamptz not null,
  until timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform)
);
select private.addon_table_policies('addon_outreach.request_pauses', 'outreach.use', 'outreach.use', null, null);

-- Each person writes only their own; they and the business's managers read it.
create policy request_pauses_own_read on addon_outreach.request_pauses as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'outreach.manage'));
create policy request_pauses_own_insert on addon_outreach.request_pauses as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy request_pauses_own_update on addon_outreach.request_pauses as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
