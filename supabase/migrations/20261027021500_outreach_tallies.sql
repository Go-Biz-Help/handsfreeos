-- =============================================================================
-- Social Outreach: what the extension does, counted, and the live ticker
-- (docs/outreach.md, decision 140).
--
-- The owner's decision (31 Oct 2026, "all of your picks"): count everything
-- the extension does on its own, a day, a week and a month at a time, on each
-- network and all together, from zero on the day this goes live; and a ticker
-- of what it's doing that very second along the bottom of every Social
-- Outreach page.
--
--        `tallies` keeps how many of each thing a person's extension did on
--        a business day, on a network: one row a person, day, network and
--        kind, added to in the same transaction as the save that says it was
--        done. It holds no names, so owners and admins may read the team's;
--        each person writes only their own. The worker lets rows over 400
--        days old go.
--
--        `computers.watched_until` says until when a ticker of the person's
--        is on screen: meanwhile the extension's line is passed on every few
--        seconds instead of every 45.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.tallies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- The business's day it was done on.
  day date not null,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  kind text not null check (kind in (
    'friend_request', 'like', 'comment', 'message', 'recommend', 'accepted', 'post_up',
    'profile', 'post', 'chat', 'found', 'listed', 'occasion', 'event',
    'group', 'joined', 'member', 'group_listed',
    'cancelled', 'unfriended', 'declined',
    'drafted')),
  n integer not null default 0 check (n >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, day, platform, kind)
);
create index tallies_day_idx on addon_outreach.tallies (workspace_id, day);
select private.addon_table_policies('addon_outreach.tallies', 'outreach.use', 'outreach.use', null, null);

-- Each person writes only their own; they and the business's managers read them (counts, never names).
create policy tallies_own_read on addon_outreach.tallies as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'outreach.manage'));
create policy tallies_own_insert on addon_outreach.tallies as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy tallies_own_update on addon_outreach.tallies as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.computers add column watched_until timestamptz;
