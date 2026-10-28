-- =============================================================================
-- Social Outreach: events near you on Alignable (docs/outreach.md, decision
-- 112).
--
-- The owner's decision (settled):
--
--        Once a week it reads events near you, and their hosts and
--        attendees go to the AI to check. It never signs you up.
--
-- `event_reads` keeps, for each person, when their computer last read the
-- events in their town, and the addresses of the events it read lately (the
-- newest first, up to 60), so none is read twice.
--
-- An event's hosts and guests are found people (`finds.how` takes `event`),
-- checked by the AI from their own page before anything is done for them.
--
-- Only adds: a table, and a check that lets one more kind.
-- =============================================================================

create table addon_outreach.event_reads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null default 'alignable' check (platform in ('alignable')),
  read_at timestamptz not null,
  urls text[] not null default '{}' check (cardinality(urls) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform)
);
select private.addon_table_policies('addon_outreach.event_reads', 'outreach.use', 'outreach.use', null, null);
create policy event_reads_own on addon_outreach.event_reads as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.finds drop constraint finds_how_check;
alter table addon_outreach.finds add constraint finds_how_check
  check (how in ('posted', 'liked', 'commented', 'searched', 'member', 'event', 'follows'));
