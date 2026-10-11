-- =============================================================================
-- Social Outreach (outreach): groups, theirs first, then new ones
-- (docs/outreach.md, decision 48).
--
--        The AI checks a group for whether the playbook's people are there
--        and post, from what its About page says, its rules, and a few of
--        its latest posts. What the About page and the rules say is kept
--        on the group (`about`, `rules`): the business's, like the rest of
--        what's kept about a group, and read again for the helpful posts
--        written for it later (decision 50). The posts read for the check
--        wait in `check_lines` until the AI reads them, then go. The AI's
--        answer is the group's (`check_state`, `check_why`, `check_who`,
--        the playbook it fits).
--
--        `joins` keeps each person's asks to join a group (decision 31):
--        asked, waiting for the admins' OK, joined, or couldn't, with the
--        answers the AI gave to the group's questions. Each person's own: a
--        restrictive policy keeps each request to its own rows.
--
--        Checking groups and joining them are asks like the Groups tab's
--        others, so `asks` takes `group_checks` and `join`. Joining on its
--        own when people left to reach run low is each person's choice
--        (`automation.join_groups`, kept since 20261027001200 and unused
--        until now: on to start, for everyone).
--
-- Only adds: columns, a table, two kinds more that `asks` takes, and
-- `join_groups` on for everyone, since nothing set it before.
-- =============================================================================

alter table addon_outreach.groups
  add column about text[] not null default '{}' check (cardinality(about) <= 30),
  add column rules text[] not null default '{}' check (cardinality(rules) <= 20),
  add column about_at timestamptz,
  add column check_lines text[] not null default '{}' check (cardinality(check_lines) <= 10),
  add column check_state text check (check_state in ('waiting', 'good', 'maybe', 'not', 'failed')),
  add column check_why text[] not null default '{}' check (cardinality(check_why) <= 3),
  add column check_who text check (check_who is null or length(btrim(check_who)) between 1 and 200),
  add column check_playbook_id uuid,
  add column checked_at timestamptz,
  add constraint groups_check_playbook_fkey foreign key (workspace_id, check_playbook_id)
    references addon_outreach.playbooks (workspace_id, id) on delete set null (check_playbook_id);
create index groups_check_waiting_idx on addon_outreach.groups (workspace_id, about_at)
  where check_state = 'waiting';
create index groups_check_playbook_idx on addon_outreach.groups (check_playbook_id)
  where check_playbook_id is not null;

create table addon_outreach.joins (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  group_id uuid not null,
  state text not null check (state in ('asked', 'pending', 'joined', 'failed')),
  -- The group's questions and the AI's answers: [{ "question": "...", "answer": "..." }].
  answers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(answers) = 'array' and jsonb_array_length(answers) <= 10),
  why text check (why is null or length(btrim(why)) between 1 and 300),
  asked_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, group_id),
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id) on delete cascade
);
create index joins_user_idx on addon_outreach.joins (workspace_id, user_id, asked_at desc);
create index joins_group_idx on addon_outreach.joins (group_id);
select private.addon_table_policies('addon_outreach.joins', 'outreach.use', 'outreach.use', null, null);
create policy joins_own on addon_outreach.joins as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'lookup', 'checks', 'cancel', 'unfriend', 'group_checks', 'join'));

-- Kept since the extension first worked on its own (20261027001200) and unused until now: on to start, for everyone.
alter table addon_outreach.automation alter column join_groups set default true;
update addon_outreach.automation set join_groups = true where not join_groups;
