-- =============================================================================
-- AI Social Media Content Creator (socialcontent): its permissions, and its own tables
-- (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, docs/socialcontent.md).
--
--        Started by `pnpm addon:new socialcontent`. The permissions are its
--        manifest's, and exist only while it runs in a business; the parity
--        test checks the two lists match. It was on the planned list under the
--        same id, so the votes for it carry over.
--
--        **Niches** are what the business's content is about: its own, and the
--        similar ones the AI suggests (3 to 5) or someone adds, each with the
--        words to search each network for. Only the ones ticked are searched.
--
--        **Creators** are people outside the business whose posts it studies:
--        found by searching a niche (suggested, for someone to tick) or added
--        by someone from a link (studied straight away). They're research,
--        never customers.
--
--        **Posts** are a studied creator's posts with their numbers, read back
--        12 months by the HandsFreeOS Social extension. Whether each is a
--        standout (2 times the middle of the 10 posts each side of it, on views
--        or on likes plus comments) is worked out in core whenever the
--        creator's posts are saved, and kept here to list them.
--
--        **Work** is what the business's reading computer is asked to do: find
--        creators for a niche on a network, read a creator's profile, read a
--        creator's posts. One of each about the same thing is open at a time.
--
--        **Settings** are one row per business: the networks it studies,
--        whose computer does the reading, and whether it watches standout
--        videos (off until an owner or admin turns it on: it uses more AI).
--
--        The AI's **notes** on each standout (why it worked, its hook, format
--        and techniques) and what it saw and heard **watching** a standout
--        video are kept on the post. The **Playbook** is one row per business:
--        the patterns across all the noted standouts. **Ideas** are posts the
--        AI suggests the business makes, from the Playbook and its profile.
-- =============================================================================

select private.register_addon_permissions('socialcontent', '[
  {"key": "socialcontent.use", "label": "Use AI Social Media Content Creator",
   "description": "See the creators, standout posts and notes, pick niches and creators to study, and ask for them to be read again.",
   "defaultRoles": ["admin", "member"]},
  {"key": "socialcontent.manage", "label": "Set up content research",
   "description": "Pick the networks studied and whose computer reads them.",
   "defaultRoles": ["admin"], "requires": ["socialcontent.use"]}
]'::jsonb);

select private.create_addon_schema('socialcontent');

-- ---------- settings ----------
create table addon_socialcontent.settings (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  networks text[] not null default '{instagram}'
    check (networks <@ array['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube']::text[]
           and cardinality(networks) <= 5),
  -- Whose computer reads the networks: their HandsFreeOS Social extension takes the work.
  reader_user_id uuid references app.users (id) on delete set null,
  -- Watching standout videos (frames and sound) uses more AI, so it starts off (decision 9).
  watch_videos boolean not null default false,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index settings_reader_idx on addon_socialcontent.settings (reader_user_id) where reader_user_id is not null;
create index settings_updated_by_idx on addon_socialcontent.settings (updated_by) where updated_by is not null;
select private.addon_table_policies('addon_socialcontent.settings', 'socialcontent.use', 'socialcontent.manage');

-- ---------- niches ----------
create table addon_socialcontent.niches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- The business's own niche, rather than a similar one.
  own boolean not null default false,
  state text not null default 'suggested' check (state in ('suggested', 'picked', 'skipped')),
  -- Why the AI thinks it's like the business's.
  why text check (why is null or length(why) <= 300),
  -- The words to search each network for it, by network: written by the AI.
  searches jsonb not null default '{}'::jsonb
    check (jsonb_typeof(searches) = 'object' and octet_length(searches::text) <= 8000),
  -- Who added it; null for the AI.
  added_by uuid references app.users (id) on delete set null,
  decided_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index niches_name_idx on addon_socialcontent.niches (workspace_id, lower(btrim(name)));
create unique index niches_own_idx on addon_socialcontent.niches (workspace_id) where own;
create index niches_added_by_idx on addon_socialcontent.niches (added_by) where added_by is not null;
create index niches_decided_by_idx on addon_socialcontent.niches (decided_by) where decided_by is not null;
select private.addon_table_policies('addon_socialcontent.niches', 'socialcontent.use', 'socialcontent.use');

-- ---------- creators ----------
create table addon_socialcontent.creators (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  network text not null check (network in ('instagram', 'facebook', 'linkedin', 'tiktok', 'youtube')),
  -- Their name on the network: a username, or the part of their address that's theirs.
  handle text not null check (length(handle) between 1 and 200),
  name text check (name is null or length(name) <= 200),
  link text not null check (link ~ '^https://' and length(link) <= 500),
  bio text check (bio is null or length(bio) <= 1000),
  followers integer check (followers is null or followers >= 0),
  last_post_at timestamptz,
  niche_id uuid,
  -- `suggested`: found by a search, for someone to tick. `studying`: its posts are read and weighed.
  -- `skipped`: someone said no. `didnt_fit`: a search found them, but they had fewer followers or hadn't posted lately.
  state text not null default 'suggested' check (state in ('suggested', 'studying', 'skipped', 'didnt_fit')),
  found_by text not null check (found_by in ('search', 'person')),
  added_by uuid references app.users (id) on delete set null,
  decided_by uuid references app.users (id) on delete set null,
  -- What the search saw ("12,400 followers, posted 3 days ago").
  why text check (why is null or length(why) <= 300),
  profile_read_at timestamptz,
  posts_read_at timestamptz,
  posts_count integer not null default 0 check (posts_count >= 0),
  standouts_count integer not null default 0 check (standouts_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, network, handle),
  foreign key (workspace_id, niche_id) references addon_socialcontent.niches (workspace_id, id)
    on delete set null (niche_id)
);
create index creators_state_idx on addon_socialcontent.creators (workspace_id, state, network);
create index creators_niche_idx on addon_socialcontent.creators (workspace_id, niche_id) where niche_id is not null;
create index creators_added_by_idx on addon_socialcontent.creators (added_by) where added_by is not null;
create index creators_decided_by_idx on addon_socialcontent.creators (decided_by) where decided_by is not null;
select private.addon_table_policies('addon_socialcontent.creators', 'socialcontent.use', 'socialcontent.use');

-- ---------- posts ----------
create table addon_socialcontent.posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  creator_id uuid not null,
  -- The network's own id for the post.
  post_key text not null check (length(post_key) between 1 and 200),
  link text not null check (link ~ '^https://' and length(link) <= 500),
  posted_at timestamptz not null,
  kind text not null default 'other' check (kind in ('video', 'photo', 'carousel', 'text', 'link', 'other')),
  caption text check (caption is null or length(caption) <= 3000),
  views integer check (views is null or views >= 0),
  likes integer check (likes is null or likes >= 0),
  comments integer check (comments is null or comments >= 0),
  shares integer check (shares is null or shares >= 0),
  seconds integer check (seconds is null or seconds between 0 and 86400),
  pinned boolean not null default false,
  -- Against the median of the posts around it (core's standouts.ts), worked out on every save of the creator's posts.
  views_times numeric(8, 2) check (views_times is null or views_times >= 0),
  engagement_times numeric(8, 2) check (engagement_times is null or engagement_times >= 0),
  standout boolean not null default false,
  standout_on text check (standout_on is null or standout_on in ('views', 'engagement', 'both')),
  -- Why it isn't weighed yet: under 7 days old, or too few posts around it.
  waiting text check (waiting is null or waiting in ('too_new', 'too_few')),
  -- The AI's notes on a standout: why it worked, its hook, format, topic and techniques (core's notes-ai.ts).
  notes jsonb check (notes is null or (jsonb_typeof(notes) = 'object' and octet_length(notes::text) <= 8000)),
  noted_at timestamptz,
  -- What the AI saw and heard watching a standout video (decision 9, only when watching is on or being tried).
  watched jsonb check (watched is null or (jsonb_typeof(watched) = 'object' and octet_length(watched::text) <= 8000)),
  watched_at timestamptz,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, creator_id, post_key),
  check (standout = (standout_on is not null)),
  foreign key (workspace_id, creator_id) references addon_socialcontent.creators (workspace_id, id)
    on delete cascade
);
create index posts_creator_idx on addon_socialcontent.posts (workspace_id, creator_id, posted_at desc);
create index posts_standout_idx on addon_socialcontent.posts (workspace_id, posted_at desc) where standout;
create index posts_unnoted_idx on addon_socialcontent.posts (workspace_id, posted_at desc)
  where standout and noted_at is null;
select private.addon_table_policies('addon_socialcontent.posts', 'socialcontent.use', 'socialcontent.use');

-- ---------- work ----------
create table addon_socialcontent.work (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- `find`: search a niche on a network for creators. `profile`: read a creator's profile.
  -- `posts`: read a creator's posts back to `since`. `watch`: watch one standout video (decision 9).
  kind text not null check (kind in ('find', 'profile', 'posts', 'watch')),
  network text not null check (network in ('instagram', 'facebook', 'linkedin', 'tiktok', 'youtube')),
  niche_id uuid,
  creator_id uuid,
  post_id uuid,
  since timestamptz,
  state text not null default 'waiting' check (state in ('waiting', 'taken', 'done', 'failed', 'stopped')),
  -- What asked for it: a person, the weekly or monthly check, a creator added or ticked, a new standout
  -- video while watching is on, or Try it on a few videos.
  asked_for text not null check (asked_for in ('person', 'weekly', 'monthly', 'added', 'studying', 'standout', 'trying')),
  asked_by uuid references app.users (id) on delete set null,
  taken_by uuid references app.users (id) on delete set null,
  taken_at timestamptz,
  finished_at timestamptz,
  failure text check (failure is null or length(failure) <= 300),
  -- How many it found or read, said on the Settings page.
  done_count integer check (done_count is null or done_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((kind = 'find') = (niche_id is not null)),
  check ((kind = 'find') = (creator_id is null)),
  check ((kind = 'watch') = (post_id is not null)),
  foreign key (workspace_id, niche_id) references addon_socialcontent.niches (workspace_id, id) on delete cascade,
  foreign key (workspace_id, creator_id) references addon_socialcontent.creators (workspace_id, id) on delete cascade,
  foreign key (workspace_id, post_id) references addon_socialcontent.posts (workspace_id, id) on delete cascade
);
-- One open of each kind about the same thing.
create unique index work_open_idx on addon_socialcontent.work (
  workspace_id, kind, network,
  coalesce(niche_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(creator_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(post_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where state in ('waiting', 'taken');
create index work_next_idx on addon_socialcontent.work (workspace_id, created_at) where state = 'waiting';
create index work_recent_idx on addon_socialcontent.work (workspace_id, created_at desc);
create index work_niche_idx on addon_socialcontent.work (workspace_id, niche_id) where niche_id is not null;
create index work_creator_idx on addon_socialcontent.work (workspace_id, creator_id) where creator_id is not null;
create index work_post_idx on addon_socialcontent.work (workspace_id, post_id) where post_id is not null;
create index work_asked_by_idx on addon_socialcontent.work (asked_by) where asked_by is not null;
create index work_taken_by_idx on addon_socialcontent.work (taken_by) where taken_by is not null;
select private.addon_table_policies('addon_socialcontent.work', 'socialcontent.use', 'socialcontent.use');

-- ---------- playbook ----------
-- One per business: the patterns across its noted standouts, in sections (hooks, formats, topics, captions,
-- timing…), each with what to do, why it works and the standouts it came from. The AI writes it again as new
-- standouts are noted, or when someone asks.
create table addon_socialcontent.playbook (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  summary text check (summary is null or length(summary) <= 2000),
  sections jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sections) = 'array' and octet_length(sections::text) <= 60000),
  -- How many noted standouts it was written from.
  standouts integer not null default 0 check (standouts >= 0),
  written_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select private.addon_table_policies('addon_socialcontent.playbook', 'socialcontent.use', 'socialcontent.use');

-- ---------- ideas ----------
-- Posts the AI suggests the business makes, from the Playbook and its profile: what it's about, its hook, its
-- format and an outline, why it should work, and the standouts it's based on. Someone saves, uses or skips each.
create table addon_socialcontent.ideas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  hook text check (hook is null or length(hook) <= 300),
  format text check (format is null or length(format) <= 100),
  network text check (network is null or network in ('instagram', 'facebook', 'linkedin', 'tiktok', 'youtube')),
  outline text check (outline is null or length(outline) <= 2000),
  why text check (why is null or length(why) <= 600),
  -- The standouts it's based on (posts' ids, kept as a list: a deleted post just stops showing).
  based_on uuid[] not null default '{}' check (cardinality(based_on) <= 10),
  state text not null default 'new' check (state in ('new', 'saved', 'used', 'skipped')),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index ideas_state_idx on addon_socialcontent.ideas (workspace_id, state, created_at desc);
create index ideas_decided_by_idx on addon_socialcontent.ideas (decided_by) where decided_by is not null;
select private.addon_table_policies('addon_socialcontent.ideas', 'socialcontent.use', 'socialcontent.use');
