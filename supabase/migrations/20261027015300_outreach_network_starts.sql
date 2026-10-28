-- =============================================================================
-- Social Outreach: when each person started on each network (docs/outreach.md, decision 96).
--
-- The owner's decision (settled): a network's daily limits are half for a person's first 2 weeks there, and 2 more
-- for an account under a year old, so the network gets used to them slowly.
--
--        `network_starts` keeps, for each person and network, when their first step there was taken. It's written
--        with that first step, and moves only to an earlier one noted later, as from a browser that was offline.
--        One row a person a network.
--
-- The rows for steps already taken come from the steps themselves, so nobody already going starts over at half.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.network_starts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  first_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform)
);
select private.addon_table_policies('addon_outreach.network_starts', 'outreach.use', 'outreach.use', null, null);

-- Each person writes only their own; they and the business's managers read it, as the team's live view halves limits.
create policy network_starts_own_read on addon_outreach.network_starts as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'outreach.manage'));
create policy network_starts_own_insert on addon_outreach.network_starts as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy network_starts_own_update on addon_outreach.network_starts as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

insert into addon_outreach.network_starts (workspace_id, user_id, platform, first_at)
select t.workspace_id, t.user_id, p.platform, min(t.at)
from addon_outreach.touches t
join addon_outreach.profiles p on p.id = t.profile_id
where t.user_id is not null
group by t.workspace_id, t.user_id, p.platform
on conflict (workspace_id, user_id, platform) do nothing;
