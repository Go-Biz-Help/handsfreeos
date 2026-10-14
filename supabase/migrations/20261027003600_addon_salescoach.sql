-- =============================================================================
-- AI Sales Coach (salescoach): its permissions, and its own tables
-- (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, docs/salescoach.md).
--
--        Started by `pnpm addon:new salescoach`. The permissions are its
--        manifest's, and exist only while it runs in a business; the parity
--        test checks the two lists match. It took in the planned Live Sales
--        Assist (`salesassist`), whose id is never used again: a business's
--        vote for it counts for Sales Coach now (Chris, 2026-10-14).
--
--        **Playbooks** are the scripts, objection answers and talking points
--        the coach says from: read by everyone it coaches, written by owners
--        and admins (`salescoach.manage`). One is the usual one.
--
--        **A coached call** is the add-on's notes on one of core's calls, the
--        one on the customer's timeline: what was said, the playbook it used,
--        and after it the summary, the follow-up, the promises and the score.
--        Only the rep on it and the people who review (`salescoach.review`)
--        see it, and only the worker writes it.
--
--        **Cards** are what the coach showed the rep during the call. Only the
--        rep sees them, and the rep's only change is to put one away.
-- =============================================================================

select private.register_addon_permissions('salescoach', '[
  {"key": "salescoach.use", "label": "Be coached on calls",
   "description": "Get live coaching on your own calls, and see your own coached calls, notes and scores.",
   "defaultRoles": ["admin", "member"]},
  {"key": "salescoach.review", "label": "See everyone’s coached calls",
   "description": "See every rep’s coached calls, notes and scores.",
   "defaultRoles": ["admin"], "requires": ["salescoach.use"]},
  {"key": "salescoach.manage", "label": "Write the playbooks",
   "description": "Write and change the scripts, objection answers and talking points the coach uses.",
   "defaultRoles": ["admin"], "requires": ["salescoach.use"]}
]'::jsonb);

select private.create_addon_schema('salescoach');

-- ---------- playbooks ----------
create table addon_salescoach.playbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null default 'any' check (kind in ('first_call', 'estimate', 'follow_up', 'any')),
  -- The one a call uses unless the rep picks another.
  is_default boolean not null default false,
  -- Steps, objections and talking points, in the add-on's own shape.
  details jsonb not null check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 200000),
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  archived_at timestamptz,
  archived_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (archived_by is null or archived_at is not null),
  check (not (is_default and archived_at is not null))
);
create unique index playbooks_name_idx on addon_salescoach.playbooks (workspace_id, lower(btrim(name)))
  where archived_at is null;
create unique index playbooks_default_idx on addon_salescoach.playbooks (workspace_id) where is_default;
create index playbooks_created_by_idx on addon_salescoach.playbooks (created_by) where created_by is not null;
create index playbooks_updated_by_idx on addon_salescoach.playbooks (updated_by) where updated_by is not null;
create index playbooks_archived_by_idx on addon_salescoach.playbooks (archived_by) where archived_by is not null;
select private.addon_table_policies('addon_salescoach.playbooks', 'salescoach.use', 'salescoach.manage', null, null);

-- ---------- coached calls ----------
create table addon_salescoach.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Core's call, which is what the customer's timeline shows.
  call_id uuid not null references app.calls (id) on delete cascade,
  -- The rep on it.
  user_id uuid references app.users (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  playbook_id uuid,
  -- Its name then, so a call reads the same after the playbook is renamed or archived.
  playbook_name text check (playbook_name is null or length(playbook_name) <= 80),
  state text not null default 'live' check (state in ('live', 'writing', 'done', 'failed')),
  -- The script step the call is at, while it's live.
  step text check (step is null or step ~ '^s[0-9]{1,3}$'),
  -- What was said, both sides, once it's over.
  lines jsonb not null default '[]'::jsonb
    check (jsonb_typeof(lines) = 'array' and octet_length(lines::text) <= 500000),
  -- The write-up: summary, notes, promises, follow-up, objections, steps covered, tips and the score.
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 50000)),
  -- Why there's no write-up, in words for the rep.
  failure text check (failure is null or length(failure) <= 300),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (call_id),
  foreign key (workspace_id, playbook_id) references addon_salescoach.playbooks (workspace_id, id)
    on delete set null (playbook_id)
);
create index calls_user_idx on addon_salescoach.calls (workspace_id, user_id, started_at desc);
create index calls_user_id_idx on addon_salescoach.calls (user_id) where user_id is not null;
create index calls_person_idx on addon_salescoach.calls (person_id) where person_id is not null;
create index calls_playbook_idx on addon_salescoach.calls (workspace_id, playbook_id) where playbook_id is not null;
select private.addon_table_policies('addon_salescoach.calls', 'salescoach.use', 'salescoach.use', null, null);
-- The rep on it, and whoever reviews, see it. Only the worker writes it.
create policy calls_own_read on addon_salescoach.calls as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'salescoach.review'));
create policy calls_worker_insert on addon_salescoach.calls as restrictive for insert to authenticated
  with check (false);
create policy calls_worker_update on addon_salescoach.calls as restrictive for update to authenticated
  using (false);

-- ---------- cards ----------
create table addon_salescoach.cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  coached_call_id uuid not null,
  user_id uuid references app.users (id) on delete set null,
  kind text not null check (kind in ('objection', 'fact', 'step', 'question')),
  title text not null check (length(btrim(title)) between 1 and 80),
  say text not null check (length(btrim(say)) between 1 and 400),
  -- What the customer said that it answers.
  heard text not null default '' check (length(heard) <= 200),
  -- The playbook's objection it answers, when it's one there.
  objection_id text check (objection_id is null or objection_id ~ '^o[0-9]{1,3}$'),
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, coached_call_id) references addon_salescoach.calls (workspace_id, id)
    on delete cascade
);
create index cards_call_idx on addon_salescoach.cards (workspace_id, coached_call_id, created_at);
create index cards_user_idx on addon_salescoach.cards (user_id) where user_id is not null;
select private.addon_table_policies('addon_salescoach.cards', 'salescoach.use', 'salescoach.use', null, null);
-- Only the rep sees their cards, and only puts them away; the worker makes them.
create policy cards_own_read on addon_salescoach.cards as restrictive for select to authenticated
  using (user_id = (select auth.uid()));
create policy cards_worker_insert on addon_salescoach.cards as restrictive for insert to authenticated
  with check (false);
create policy cards_own_update on addon_salescoach.cards as restrictive for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- Live Sales Assist's votes ----------
-- A business that voted for Live Sales Assist has voted for Sales Coach, which is it now. Its pick, if it had one,
-- carries over too, unless Sales Coach already has its own.
insert into platform.addon_votes (addon_id, workspace_id, voted_by, created_at)
  select 'salescoach', workspace_id, voted_by, created_at from platform.addon_votes where addon_id = 'salesassist'
  on conflict (addon_id, workspace_id) do nothing;
delete from platform.addon_votes where addon_id = 'salesassist';
update platform.addon_picks set addon_id = 'salescoach'
  where addon_id = 'salesassist' and not exists (select 1 from platform.addon_picks where addon_id = 'salescoach');
delete from platform.addon_picks where addon_id = 'salesassist';
delete from platform.addon_vote_counts where addon_id = 'salesassist' and votes = 0;
