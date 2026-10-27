-- =============================================================================
-- Social Outreach (outreach): finding people by topic on Instagram, LinkedIn
-- and Alignable (docs/outreach.md, decision 92).
--
--        `finds` keeps everyone the person's computer found about the
--        business's topic, for the teammate whose computer found them, each
--        once: the writer of a post the AI called good (`posted`), who liked
--        or reacted to it (`liked`), who commented (`commented`), a business
--        an Alignable search showed (`searched`) and a group's member
--        (`member`). With it, the post or group it came from, the words it
--        was found with, the place a search showed, and what a commenter
--        said, until the AI's check reads it (or 14 days have gone since it
--        was kept). Never in `engagements` and never in Contacts: each is a
--        profile with no customer, as a post's writer is. Each person's own,
--        like their partner leads.
--
--        A check says whether it was of someone the person knows or someone
--        found (`checks.via`), so the day's found checks are counted on
--        their own. A post keeps the hashtag or phrase that found it
--        (`posts.words`) and when its people were read (`people_read_at`).
--        A comment on Instagram and Alignable goes through `sends` like a
--        message, with its post (`sends.post_id`, kind `comment`).
--
-- Only adds: a new table, three columns and a kind more that `sends` takes, each empty until set. Groups need
-- nothing: their `platform` takes Alignable already, and a members page read with no leaders sets `admins_read_at`.
-- =============================================================================

create table addon_outreach.finds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  -- How they were found, the strongest first: wrote a good post, commented on one, liked or reacted to one, a group's
  -- member, a search's result. Found again, it changes only to a stronger one.
  how text not null check (how in ('posted', 'liked', 'commented', 'searched', 'member')),
  post_id uuid,
  group_id uuid,
  -- The hashtag, phrase or kind of business it was found with, and the place a search showed.
  words text check (words is null or length(words) between 1 and 160),
  place text check (place is null or length(place) between 1 and 100),
  -- What a commenter said, and when it was kept: emptied once the AI's check reads it, or 14 days after it was kept.
  said text check (said is null or length(said) between 1 and 300),
  said_at timestamptz,
  found_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, post_id) references addon_outreach.posts (workspace_id, id) on delete set null (post_id),
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id) on delete set null (group_id)
);
create index finds_user_idx on addon_outreach.finds (workspace_id, user_id, platform, found_at desc);
create index finds_profile_idx on addon_outreach.finds (workspace_id, profile_id);
create index finds_post_idx on addon_outreach.finds (workspace_id, post_id);
create index finds_group_idx on addon_outreach.finds (workspace_id, group_id) where group_id is not null;
select private.addon_table_policies('addon_outreach.finds', 'outreach.use', 'outreach.use', null, null);
create policy finds_own on addon_outreach.finds as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- A check of someone the person knows, or of someone found (decision 92): the server sets it at each look.
alter table addon_outreach.checks
  add column via text not null default 'known' check (via in ('known', 'found'));
create index checks_found_idx on addon_outreach.checks (workspace_id, user_id, looked_at) where via = 'found';

-- When a good post's likers and commenters were read, and the hashtag or phrase that found it (null for a group's or
-- a feed's post; the first one kept).
alter table addon_outreach.posts
  add column people_read_at timestamptz,
  add column words text check (words is null or length(words) between 1 and 160);
create index posts_people_idx on addon_outreach.posts (workspace_id, user_id, seen_at desc)
  where people_read_at is null;

-- A comment on Instagram and Alignable waits with its post, as a message does (decision 92).
alter table addon_outreach.sends
  add column post_id uuid,
  add constraint sends_post_fkey foreign key (workspace_id, post_id)
    references addon_outreach.posts (workspace_id, id) on delete cascade;
create index sends_post_idx on addon_outreach.sends (workspace_id, post_id) where post_id is not null;
alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in',
    'partner_ask', 'partner_follow_up', 'partner_details', 'partner_reply', 'comment'));
alter table addon_outreach.sends
  add constraint sends_comment_post check ((kind = 'comment') = (post_id is not null));
