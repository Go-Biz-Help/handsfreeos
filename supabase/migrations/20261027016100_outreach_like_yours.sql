-- =============================================================================
-- Social Outreach: Instagram accounts like yours (docs/outreach.md, decision
-- 110).
--
-- The owner's decision (settled):
--
--        The AI picks up to 5 accounts (a chamber, a venue, a partner) from
--        your playbook. You can add or remove them in Settings. It reads
--        their recent commenters and some followers each day.
--
-- `like_yours` keeps the business's accounts: those an Instagram search
-- showed, waiting for the AI to look at (`candidate`), the ones kept, those
-- it passed over and those a person removed, each once by its username, with
-- who added it (null for the AI) and when it was last read.
--
-- An account's latest posts are kept for their people as a good post's are
-- (`posts.found` takes `account`), and its followers are found people
-- (`finds.how` takes `follows`).
--
-- Only adds: a table, and two checks that each let one more kind.
-- =============================================================================

create table addon_outreach.like_yours (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  platform text not null default 'instagram' check (platform in ('instagram')),
  -- In lower case, as Instagram allows it.
  username text not null check (username ~ '^[a-z0-9._]{1,30}$'),
  name text check (name is null or length(btrim(name)) between 1 and 120),
  -- Why the AI picked it, or the words its search went with.
  why text check (why is null or length(btrim(why)) between 1 and 200),
  state text not null check (state in ('candidate', 'kept', 'passed', 'removed')),
  -- Who added it in Settings; null when the AI picked it.
  added_by_user_id uuid references app.users (id) on delete set null,
  found_at timestamptz not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, platform, username)
);
create index like_yours_kept_idx on addon_outreach.like_yours (workspace_id, platform, read_at nulls first)
  where state = 'kept';
select private.addon_table_policies('addon_outreach.like_yours', 'outreach.use', 'outreach.use', null, null);

alter table addon_outreach.posts drop constraint posts_found_check;
alter table addon_outreach.posts add constraint posts_found_check
  check (found in ('scroll', 'find', 'watch', 'search', 'account'));

alter table addon_outreach.finds drop constraint finds_how_check;
alter table addon_outreach.finds add constraint finds_how_check
  check (how in ('posted', 'liked', 'commented', 'searched', 'member', 'follows'));
