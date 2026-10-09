-- =============================================================================
-- Social Outreach (outreach): tidying the person's own friends, and
-- Facebook's warnings (docs/outreach.md, decisions 10, 12, 17 and 25).
--
--        `friend_ends` keeps each sent request the extension cancelled, and
--        each friend it unfriended, for the person who ticked them in its
--        panel: the daily limits count them. Where the person's Facebook
--        stands with each one afterwards is in `friends`, as before.
--
--        `warnings` keeps each warning Facebook showed the person (that
--        they're blocked from something for a while, went too fast, or need
--        to check their account), in Facebook's own words. One halves their
--        daily limits for a week, keeps friend requests off Today's list for
--        two days, and stops what the extension does for them that day.
-- =============================================================================

create table addon_outreach.friend_ends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  kind text not null check (kind in ('cancel_request', 'unfriend')),
  at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index friend_ends_user_at_idx on addon_outreach.friend_ends (workspace_id, user_id, at);
create index friend_ends_profile_idx on addon_outreach.friend_ends (profile_id);
select private.addon_table_policies('addon_outreach.friend_ends', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.warnings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  -- Facebook's words, a line each, as the page showed them.
  words text[] not null check (cardinality(words) between 1 and 5),
  url text check (url is null or (length(url) between 1 and 500 and url ~ '^https://')),
  at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index warnings_user_at_idx on addon_outreach.warnings (workspace_id, user_id, at desc);
select private.addon_table_policies('addon_outreach.warnings', 'outreach.use', 'outreach.use', null, null);
