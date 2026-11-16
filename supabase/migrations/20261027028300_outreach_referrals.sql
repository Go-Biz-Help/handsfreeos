-- =============================================================================
-- Social Outreach (outreach): referring people the person talked with on
-- posts asking for a recommendation (docs/outreach.md, decision 174).
--
--        `posts.asks` keeps what a post asks people to recommend someone
--        for, as the AI's check of it said ("a roofer in Boise"), whatever
--        else the check made of it; null when it asks for none.
--
--        `referrals` keeps each person the worker found to refer under one
--        of those posts: who, why they fit, the comment naming them and the
--        heads-up to them, as the AI wrote them, and where it stands:
--        waiting for the person, done (they commented and sent it), or put
--        aside. One a post. Each person's own.
--
-- Only adds: a column and a table.
-- =============================================================================

alter table addon_outreach.posts
  add column if not exists asks text check (asks is null or length(btrim(asks)) between 1 and 120);

create table addon_outreach.referrals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  post_id uuid not null,
  profile_id uuid not null,
  why text check (why is null or length(btrim(why)) between 1 and 200),
  comment text not null check (length(btrim(comment)) between 1 and 1000),
  note text not null check (length(btrim(note)) between 1 and 1000),
  state text not null default 'waiting' check (state in ('waiting', 'done', 'skipped')),
  done_at timestamptz,
  skipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, post_id),
  foreign key (workspace_id, post_id) references addon_outreach.posts (workspace_id, id) on delete cascade,
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index referrals_user_idx on addon_outreach.referrals (workspace_id, user_id, created_at desc);
create index referrals_profile_idx on addon_outreach.referrals (profile_id, created_at desc);
select private.addon_table_policies('addon_outreach.referrals', 'outreach.use', 'outreach.use', null, null);
create policy referrals_own on addon_outreach.referrals as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
