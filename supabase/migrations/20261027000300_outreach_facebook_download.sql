-- =============================================================================
-- Social Outreach (outreach): Facebook's download file.
--
--        The owner's decisions (docs/outreach.md, 2 and 15): old friends and
--        chats come in from Facebook's "Download your information" file and
--        its chat backup, read in the person's browser. All it sends here is
--        names and moments: who's in each list (friends, requests either way,
--        friends removed, requests deleted, followers, following) and since
--        when, and when the person last messaged each person. Never what a
--        message said.
--
--        **Imports** are each time someone brings a file in, in parts: when
--        Facebook made the file, what it held, and when the last part came.
--
--        **File people** and **file chats** are what the file said, each
--        person's own (user_id), kept by name, since the file has no links.
--        A name that's one profile saved here is linked to it (profile_id),
--        and what the file says is put in place in `friends`. A newer file
--        updates the same rows. Nobody deletes one; they go when the
--        business deletes the add-on's data.
-- =============================================================================

-- ---------- imports ----------
create table addon_outreach.imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Whose Facebook it is.
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  -- When Facebook made the file, as near as it says.
  made_at timestamptz not null,
  -- What the whole file held, by list, once its last part is in.
  counts jsonb check (counts is null or jsonb_typeof(counts) = 'object'),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((counts is null) = (finished_at is null))
);
create index imports_user_idx on addon_outreach.imports (user_id, workspace_id, platform, finished_at);
select private.addon_table_policies('addon_outreach.imports', 'outreach.use', 'outreach.use', null, null);

-- ---------- file_people ----------
create table addon_outreach.file_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  list text not null check (list in ('friends', 'request_sent', 'request_received', 'removed', 'declined',
    'followers', 'following')),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- The name as names are matched: in lower case, spaces closed up (nameKey in download.ts).
  name_key text not null check (length(name_key) between 1 and 400),
  -- When, as the list says: since when friends, when a request was sent or deleted. Some lists don't say.
  at timestamptz,
  -- The profile saved here by that name, when there's one.
  profile_id uuid,
  -- The latest file that had them.
  import_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique nulls not distinct (user_id, workspace_id, platform, list, name_key, at),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id)
    on delete set null (profile_id),
  foreign key (workspace_id, import_id) references addon_outreach.imports (workspace_id, id) on delete cascade
);
create index file_people_profile_idx on addon_outreach.file_people (profile_id) where profile_id is not null;
create index file_people_import_idx on addon_outreach.file_people (import_id);
select private.addon_table_policies('addon_outreach.file_people', 'outreach.use', 'outreach.use', null, null);

-- ---------- file_chats ----------
create table addon_outreach.file_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  -- Who it was with, one to one.
  name text not null check (length(btrim(name)) between 1 and 200),
  name_key text not null check (length(name_key) between 1 and 400),
  first_at timestamptz not null,
  last_at timestamptz not null,
  messages integer not null check (messages > 0),
  -- Whether the latest message was the person's own.
  last_from_me boolean not null,
  profile_id uuid,
  import_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (user_id, workspace_id, platform, name_key),
  check (first_at <= last_at),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id)
    on delete set null (profile_id),
  foreign key (workspace_id, import_id) references addon_outreach.imports (workspace_id, id) on delete cascade
);
create index file_chats_profile_idx on addon_outreach.file_chats (profile_id) where profile_id is not null;
create index file_chats_import_idx on addon_outreach.file_chats (import_id);
select private.addon_table_policies('addon_outreach.file_chats', 'outreach.use', 'outreach.use', null, null);
