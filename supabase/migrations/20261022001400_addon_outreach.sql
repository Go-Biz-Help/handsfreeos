-- =============================================================================
-- Social Outreach (outreach), Phase 1 steps 1 and 2: its permissions, its
-- playbooks, and the Facebook profiles and chats the browser extension saves.
--
--        Started by `pnpm addon:new outreach` (docs/addon-architecture.md);
--        docs/outreach.md says what it is and the owner's decisions.
--
--        **People are customers.** Saving someone from Facebook finds or adds
--        a person in Contacts (source "Facebook", texting consent unknown);
--        these tables keep only what Facebook adds about them, and point at
--        core, never the other way round.
--
--        **Playbooks** say what a business is after on social media, who it's
--        for, how it sounds and which of its own tags to use. Everyone using
--        the add-on reads them; owners and admins (`outreach.manage`) write
--        them. The details are one object, checked by the add-on's own schema
--        (packages/core/src/addons/outreach/playbooks.ts).
-- =============================================================================

select private.register_addon_permissions('outreach', '[
  {"key": "outreach.use", "label": "Use Social Outreach",
   "description": "Save people and chats from Facebook with the browser extension, and see the playbooks.",
   "defaultRoles": ["admin", "member"]},
  {"key": "outreach.manage", "label": "Run Social Outreach",
   "description": "Write the playbooks: the goal, who it’s for, the words and the tags.",
   "defaultRoles": ["admin"], "requires": ["outreach.use"]}
]'::jsonb);

select private.create_addon_schema('outreach');

-- ---------- playbooks ----------
create table addon_outreach.playbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- The template it started from (`crm_demos`), or null when it started blank.
  template text check (template is null or template ~ '^[a-z][a-z_]{0,39}$'),
  -- Goal, audience, where, steps, words and tags, in the add-on's own shape.
  details jsonb not null check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 100000),
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (archived_by is null or archived_at is not null)
);
-- Two playbooks in use never share a name.
create unique index playbooks_name_idx on addon_outreach.playbooks (workspace_id, lower(btrim(name)))
  where archived_at is null;
create index playbooks_created_by_idx on addon_outreach.playbooks (created_by) where created_by is not null;
create index playbooks_updated_by_idx on addon_outreach.playbooks (updated_by) where updated_by is not null;
create index playbooks_archived_by_idx on addon_outreach.playbooks (archived_by) where archived_by is not null;
select private.addon_table_policies('addon_outreach.playbooks', 'outreach.use', 'outreach.manage', null, null);

-- ---------- profiles ----------
-- A customer's profile on a social network, as the extension last saw it.
create table addon_outreach.profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  -- The profile's number when a link to it showed one, and its username when one did: at least one, and a later
  -- save fills in the other.
  platform_id text check (platform_id is null or platform_id ~ '^[0-9]{1,30}$'),
  username text check (username is null or username ~ '^[A-Za-z0-9.]{1,100}$'),
  url text not null check (length(url) between 1 and 500 and url ~ '^https://'),
  -- Their name as the page showed it; Contacts keeps the one the business uses.
  name text not null check (length(btrim(name)) between 1 and 200),
  -- The lines under their name: work, business, town.
  intro text[] not null default '{}' check (cardinality(intro) <= 30),
  -- As it looked to whoever saw the profile last (last_seen_by).
  friendship text not null default 'unknown'
    check (friendship in ('friends', 'request_sent', 'request_received', 'not_friends', 'unknown')),
  mutual_friends integer check (mutual_friends is null or mutual_friends between 0 and 100000),
  saved_by uuid references app.users (id) on delete set null,
  last_seen_by uuid references app.users (id) on delete set null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (platform_id is not null or username is not null)
);
create unique index profiles_platform_id_idx on addon_outreach.profiles (workspace_id, platform, platform_id)
  where platform_id is not null;
create unique index profiles_username_idx on addon_outreach.profiles (workspace_id, platform, lower(username))
  where username is not null;
create index profiles_person_idx on addon_outreach.profiles (person_id);
create index profiles_saved_by_idx on addon_outreach.profiles (saved_by) where saved_by is not null;
create index profiles_last_seen_by_idx on addon_outreach.profiles (last_seen_by) where last_seen_by is not null;
select private.addon_table_policies('addon_outreach.profiles', 'outreach.use', 'outreach.use', null, null);

-- ---------- threads ----------
-- A chat with a customer, with its most recent messages.
create table addon_outreach.threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  -- The chat's number in its link. A chat with one person carries that person's number from each side, so the
  -- same number in two teammates' Facebook is two chats: whose chat it is (owner_user_id) tells them apart.
  thread_key text not null check (thread_key ~ '^[A-Za-z0-9._-]{1,64}$'),
  owner_user_id uuid references app.users (id) on delete set null,
  encrypted boolean not null default false,
  url text not null check (length(url) between 1 and 500 and url ~ '^https://'),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- Its most recent messages, oldest first: who sent each, what it said, when as Facebook showed it, and when it
  -- was first saved.
  messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(messages) = 'array' and jsonb_array_length(messages) <= 100),
  -- Every message ever saved from it, kept above or not.
  saved_messages integer not null default 0 check (saved_messages >= 0),
  last_saved_by uuid references app.users (id) on delete set null,
  last_saved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index threads_key_idx on addon_outreach.threads (workspace_id, platform, thread_key, owner_user_id)
  nulls not distinct;
create index threads_person_idx on addon_outreach.threads (person_id);
create index threads_owner_idx on addon_outreach.threads (owner_user_id) where owner_user_id is not null;
create index threads_last_saved_by_idx on addon_outreach.threads (last_saved_by) where last_saved_by is not null;
select private.addon_table_policies('addon_outreach.threads', 'outreach.use', 'outreach.use', null, null);
