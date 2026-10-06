-- =============================================================================
-- Social Outreach (outreach): tracking, for the activity panel.
--
--        The owner's decisions of 6 Oct 2026 (docs/outreach.md, 7 and 8):
--        the browser extension notes the friend requests, likes, comments
--        and messages the person sends on Facebook themselves, each with the
--        group they found the person in, and the panel counts them.
--
--        **Someone reached isn't a customer yet.** A profile can now be kept
--        without a customer (person_id null): noting a step never adds anyone
--        to Contacts. Saving the profile from the extension still does, and
--        the profile keeps its steps.
--
--        **Groups** are kept as people are found in them, by the number or
--        the name in their link, like profiles. A profile remembers the
--        group it was first found in.
--
--        **Touches** are the steps themselves: who took one (user_id), what
--        (kind), to whom (profile_id), from which group, and when. Never the
--        words of a comment or a message. A message also says whether it
--        started a chat or followed one up (step), which the daily limits
--        count. Nobody deletes one; they go with the profile, or when the
--        business deletes the add-on's data.
-- =============================================================================

alter table addon_outreach.profiles alter column person_id drop not null;

-- ---------- groups ----------
create table addon_outreach.groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  -- The group's number when a link to it showed one, and the name in its link when one did: at least one, and a
  -- later look fills in the other.
  platform_id text check (platform_id is null or platform_id ~ '^[0-9]{1,30}$'),
  slug text check (slug is null or slug ~ '^[A-Za-z0-9._-]{1,100}$'),
  url text not null check (length(url) between 1 and 500 and url ~ '^https://'),
  -- Its name as the page showed it, once a page has.
  name text check (name is null or length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (platform_id is not null or slug is not null)
);
create unique index groups_platform_id_idx on addon_outreach.groups (workspace_id, platform, platform_id)
  where platform_id is not null;
create unique index groups_slug_idx on addon_outreach.groups (workspace_id, platform, lower(slug))
  where slug is not null;
select private.addon_table_policies('addon_outreach.groups', 'outreach.use', 'outreach.use', null, null);

-- Where someone was first found.
alter table addon_outreach.profiles add column group_id uuid;
alter table addon_outreach.profiles add constraint profiles_group_fkey foreign key (workspace_id, group_id)
  references addon_outreach.groups (workspace_id, id) on delete set null (group_id);
create index profiles_group_idx on addon_outreach.profiles (group_id) where group_id is not null;

-- ---------- touches ----------
create table addon_outreach.touches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  profile_id uuid not null,
  -- Who took the step: each teammate's are their own on the panel, and owners and admins see everyone's.
  user_id uuid references app.users (id) on delete set null,
  kind text not null check (kind in ('friend_request', 'like', 'comment', 'message')),
  -- A message's place in the outreach: the first to them (a chat started), or the first on a later day that isn't
  -- answering them (a follow-up). Null for the rest, and for the other kinds.
  step text check (step in ('first_message', 'follow_up')),
  group_id uuid,
  -- The post liked or commented on, and the chat a message went in, when the page showed them.
  post_url text check (post_url is null or (length(post_url) between 1 and 500 and post_url ~ '^https://')),
  thread_key text check (thread_key is null or thread_key ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- When the person took it, which a step that waited to send keeps.
  at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (step is null or kind = 'message'),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id)
    on delete set null (group_id)
);
create index touches_workspace_at_idx on addon_outreach.touches (workspace_id, at);
create index touches_profile_idx on addon_outreach.touches (profile_id, at);
create index touches_user_idx on addon_outreach.touches (user_id, at) where user_id is not null;
create index touches_group_idx on addon_outreach.touches (group_id) where group_id is not null;
select private.addon_table_policies('addon_outreach.touches', 'outreach.use', 'outreach.use', null, null);
