-- =============================================================================
-- Social Outreach (outreach): helpful posts in the groups, and the people who
-- engage with them (docs/outreach.md, decision 50).
--
--        `helpful` keeps each post the AI drafts for a person to put up in one
--        of their groups: which group and playbook, what it's about, the
--        words, and where it stands: being drafted, a draft, OK'd, posted
--        (with its link once known), put aside, or couldn't go (with why).
--        `how` is the person's posting choice when it was drafted: they copy
--        it, the extension posts it after their OK, or on its own. At most
--        one a day, and never the same group twice in a week: the commands
--        hold that. Each person's own.
--
--        `engagements` keeps who reacted to or commented on one of those
--        posts, as the extension read it: warm leads for Today, to answer,
--        like back and friend. Each person's own.
--
--        Posting is each person's choice (`automation.posting`): after their
--        OK to start, inside what the business allows. Posting an OK'd one is
--        an ask of their computer, so `asks` takes `post`.
--
-- Only adds: two tables, a column, and a kind more that `asks` takes.
-- =============================================================================

create table addon_outreach.helpful (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  group_id uuid not null,
  playbook_id uuid,
  state text not null check (state in ('drafting', 'draft', 'approved', 'posted', 'skipped', 'failed')),
  how text not null check (how in ('copy', 'after_ok', 'own')),
  topic text check (topic is null or length(btrim(topic)) between 1 and 200),
  body text check (body is null or length(btrim(body)) between 1 and 2000),
  post_url text check (post_url is null or (length(post_url) between 1 and 500 and post_url ~ '^https://')),
  why_not text check (why_not is null or length(btrim(why_not)) between 1 and 300),
  asked_at timestamptz not null,
  drafted_at timestamptz,
  approved_at timestamptz,
  posted_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id) on delete cascade,
  foreign key (workspace_id, playbook_id) references addon_outreach.playbooks (workspace_id, id)
    on delete set null (playbook_id)
);
create index helpful_user_idx on addon_outreach.helpful (workspace_id, user_id, asked_at desc);
create index helpful_drafting_idx on addon_outreach.helpful (workspace_id, asked_at) where state = 'drafting';
create index helpful_group_idx on addon_outreach.helpful (group_id);
create index helpful_playbook_idx on addon_outreach.helpful (playbook_id) where playbook_id is not null;
select private.addon_table_policies('addon_outreach.helpful', 'outreach.use', 'outreach.use', null, null);
create policy helpful_own on addon_outreach.helpful as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table addon_outreach.engagements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  helpful_id uuid not null,
  profile_id uuid not null,
  kind text not null check (kind in ('comment', 'reaction')),
  comment text check (comment is null or length(btrim(comment)) between 1 and 1000),
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, helpful_id, profile_id, kind),
  foreign key (workspace_id, helpful_id) references addon_outreach.helpful (workspace_id, id) on delete cascade,
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index engagements_user_idx on addon_outreach.engagements (workspace_id, user_id, seen_at desc);
create index engagements_helpful_idx on addon_outreach.engagements (helpful_id);
create index engagements_profile_idx on addon_outreach.engagements (profile_id);
select private.addon_table_policies('addon_outreach.engagements', 'outreach.use', 'outreach.use', null, null);
create policy engagements_own on addon_outreach.engagements as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.automation
  add column posting text not null default 'after_ok' check (posting in ('copy', 'after_ok', 'own'));

alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'lookup', 'checks', 'cancel', 'unfriend', 'group_checks', 'join', 'post'));
