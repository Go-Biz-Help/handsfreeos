-- =============================================================================
-- Social Outreach (outreach): the setup, in HandsFreeOS (docs/outreach.md,
-- decisions 36 and 45).
--
--        `setup` keeps where each person got to in Social Outreach's setup
--        (playbooks, the team's rules, their settings, installing the
--        extension, their groups): the furthest step finished, when they
--        first started it and when they finished it, when they hid its
--        reminder, and when the extension last told HandsFreeOS it's signed
--        in for them here. One a person in a business; none until they
--        first move on, leave it for later, or the extension signs in.
--
--        A row on its own says nothing about having started: the extension
--        makes one when it signs in. `started_at` does.
--
--        `settings_at` is when the person last saved their own settings
--        (outreach.automation.save for themselves). An owner or admin saving
--        them for them never sets or clears it, so someone who chose theirs
--        once is never a first-timer again. It's filled from the settings
--        kept today whose last save was the person's own.
--
--        Each person reads and writes only their own row: the add-on's
--        policies let anyone with outreach.use in, and one restrictive
--        policy beside them keeps each request to the person's own.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.setup (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- The furthest step finished; null until one is.
  reached text check (reached in ('playbooks', 'rules', 'settings', 'extension', 'groups')),
  -- When they first moved on from a step, or left it for later: never set by the extension signing in.
  started_at timestamptz,
  finished_at timestamptz,
  -- When they hid the "Finish setting up" line on Social Outreach's tabs.
  banner_hidden_at timestamptz,
  -- The last time the extension said it's signed in for them here.
  extension_at timestamptz,
  -- The last time they saved their own settings; never set by an owner or admin saving them for them.
  settings_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id)
);
select private.addon_table_policies('addon_outreach.setup', 'outreach.use', 'outreach.use', null, null);
create policy setup_own on addon_outreach.setup as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Everyone who has already saved their own settings counts as having chosen.
insert into addon_outreach.setup (workspace_id, user_id, settings_at)
select a.workspace_id, a.user_id, a.updated_at
from addon_outreach.automation a
where a.changed_by is null
on conflict (workspace_id, user_id) do update set settings_at = excluded.settings_at;
