-- =============================================================================
-- Social Outreach: what the extension saw (docs/outreach.md, decision 74).
--
--        `reports` keeps, for a week, a note from the person's computer of
--        each page a job read: the page's kind and its address with people's
--        and groups' parts as {1}, {2}…, whether its window was in front,
--        what the readers found there (counts and the network's own section
--        names, never words), a line on what it couldn't find, and when
--        something was missing or the person asked for Check LinkedIn, the
--        page's outline (tags, roles and the network's own words; everything
--        a person wrote is "[2 words]"). Each person's are their own, on the
--        database too, as their asks are.
--
--        `asks` takes `checkup`: Check LinkedIn, asked from Settings.
--
--        `computers.allowed` is the networks Chrome lets the extension on, as
--        it last said; null from a build that doesn't say. An ask on a network
--        it isn't allowed on waits, and the app says what to press.
--
-- Only adds: a table, a kind more that `asks` takes, and a column.
-- =============================================================================

create table addon_outreach.reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- The ask it was for; null for a step of the person's day. It goes with its ask.
  ask_id uuid,
  platform text not null check (platform in ('facebook', 'linkedin')),
  -- The ask's kind, or the day's step ("like", "comment"…).
  job text not null check (char_length(job) between 1 and 40),
  version text check (version is null or char_length(version) <= 20),
  -- The page's kind as the extension's readers name it ("own-profile", "feed"…).
  page text not null check (char_length(page) between 1 and 40),
  path text not null check (char_length(path) <= 500),
  -- Whether Chrome showed the page: it draws nothing in a window hidden behind another.
  shown boolean,
  found jsonb not null default '{}'::jsonb
    check (jsonb_typeof(found) = 'object' and pg_column_size(found) <= 8192),
  note text check (note is null or char_length(note) <= 300),
  outline text check (outline is null or char_length(outline) <= 200000),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, ask_id) references addon_outreach.asks (workspace_id, id) on delete cascade
);
create index reports_user_idx on addon_outreach.reports (workspace_id, user_id, created_at desc);
create index reports_ask_idx on addon_outreach.reports (ask_id);
select private.addon_table_policies('addon_outreach.reports', 'outreach.use', 'outreach.use', null, null);

-- Each person's own, as their asks are.
create policy reports_own on addon_outreach.reports as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'lookup', 'checks', 'cancel', 'unfriend', 'group_checks', 'join', 'post',
  'research', 'profile_read', 'profile_edit', 'checkup'));

alter table addon_outreach.computers
  add column allowed text[] check (allowed is null or allowed <@ array['facebook', 'linkedin']);
