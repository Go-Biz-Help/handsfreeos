-- =============================================================================
-- Social Outreach (outreach): posts in the business's groups worth a comment
-- from the person (docs/outreach.md, decisions 18 to 20).
--
--        `posts` keeps each group post the extension found worth a look, as
--        the person scrolled a group with its panel open or as its Find posts
--        scrolled their groups: its link, who wrote it (a profile with no
--        customer, as when a step is noted), what it said, and what the AI
--        made of it. Each person's own, like their chats. The good ones go on
--        their list for today until they comment, which the extension notes
--        as before (`touches.post_url`), or put the post aside.
-- =============================================================================

create table addon_outreach.posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  group_id uuid,
  profile_id uuid not null,
  url text not null check (length(url) between 1 and 500 and url ~ '^https://'),
  posted text check (posted is null or length(posted) between 1 and 100),
  body text not null check (length(body) between 1 and 2000),
  comments integer check (comments is null or comments >= 0),
  reactions integer check (reactions is null or reactions >= 0),
  -- Why it was worth a look: "Asks for help", "Says “CRM”".
  reasons text[] not null default '{}',
  playbook_id uuid,
  found text not null check (found in ('scroll', 'find')),
  check_state text not null default 'waiting' check (check_state in ('waiting', 'good', 'not', 'failed')),
  check_why text check (check_why is null or length(check_why) between 1 and 160),
  checked_at timestamptz,
  skipped_at timestamptz,
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, url),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id) on delete set null (group_id),
  foreign key (workspace_id, playbook_id) references addon_outreach.playbooks (workspace_id, id) on delete set null (playbook_id)
);
create index posts_user_check_idx on addon_outreach.posts (workspace_id, user_id, check_state, seen_at desc);
create index posts_waiting_idx on addon_outreach.posts (workspace_id, seen_at desc) where check_state = 'waiting';
create index posts_profile_idx on addon_outreach.posts (profile_id);
create index posts_group_idx on addon_outreach.posts (group_id) where group_id is not null;
create index posts_playbook_idx on addon_outreach.posts (playbook_id) where playbook_id is not null;
select private.addon_table_policies('addon_outreach.posts', 'outreach.use', 'outreach.use', null, null);
