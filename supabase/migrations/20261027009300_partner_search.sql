-- =============================================================================
-- Social Outreach (outreach): finding partners by search
-- (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 4; docs/outreach.md
-- decision 81).
--
--        Find partners searches the network before it reads anyone: posts
--        saying a partner playbook's words, whose authors may be creators the
--        customers follow, and people matching them, who may be businesses
--        with the same customers. `partner_leads` keeps each person a search
--        found, for the teammate whose computer searched, until the AI has
--        answered for them: the kind it looked for, the words, the network,
--        and when. Nobody goes in Contacts: each is a profile with no
--        customer, as a post's author is.
--
--        `partner_searches` keeps each word searched on a network for a kind:
--        when it was last searched and how many new people it found, so each
--        is searched at most once a week and a day's searches are counted.
--
--        Each person's own, like their partner checks: the add-on's policies
--        let anyone with outreach.use in, and one restrictive policy beside
--        them keeps each request to the person's own rows. The worker lets a
--        lead go once the AI has answered.
--
-- Only adds: two new tables.
-- =============================================================================

create table addon_outreach.partner_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  -- What the search looked for: a creator (post search) or a business (people search).
  kind text not null check (kind in ('creator', 'business')),
  words text not null check (length(words) between 1 and 160),
  found_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index partner_leads_waiting_idx on addon_outreach.partner_leads (workspace_id, user_id, platform, found_at desc);
create index partner_leads_profile_idx on addon_outreach.partner_leads (profile_id);
select private.addon_table_policies('addon_outreach.partner_leads', 'outreach.use', 'outreach.use', null, null);
create policy partner_leads_own on addon_outreach.partner_leads as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table addon_outreach.partner_searches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  kind text not null check (kind in ('creator', 'business')),
  words text not null check (length(words) between 1 and 160),
  searched_at timestamptz not null,
  -- How many people it found that weren't found already, the last time.
  found integer not null default 0 check (found >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform, kind, words)
);
create index partner_searches_day_idx on addon_outreach.partner_searches (workspace_id, user_id, platform, searched_at desc);
select private.addon_table_policies('addon_outreach.partner_searches', 'outreach.use', 'outreach.use', null, null);
create policy partner_searches_own on addon_outreach.partner_searches as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
