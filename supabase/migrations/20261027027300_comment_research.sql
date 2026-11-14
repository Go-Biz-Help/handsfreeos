-- =============================================================================
-- Social Outreach: comment research (docs/outreach.md, decision 166).
--
-- The owner's ask (settled, 14 Nov 2026):
--
--        Have the extension do some extensive research on comments on all
--        different types of posts and recognize the patterns. Some comments
--        may be bots, so leave those out. About 2,000 comments over 3 days,
--        mixed into its normal day. Not something every user needs.
--
-- HandsFreeOS's own research, not a business's: only HandsFreeOS staff
-- (`platform.ai.manage`) start one, read one or use what it found, and the
-- database holds that, not only the screens.
--
-- `comment_research` is one research: who started it (only their browser reads
-- for it), where it stands, how many comments it kept and left out, the
-- hashtags it has read, and what it found. One at a time a business.
--
-- `comment_samples` keeps a comment's words alone, with the kind of post it
-- was under and under how many posts it was seen. Never who wrote it, the
-- post, its caption or its address.
--
-- `platform.comment_guides` is the guide every business's comments are
-- written with, once staff press Use it: one in use a network. The worker
-- reads it; nobody writes it but through the definers below. It names the
-- research it came from as a label, not a key: core never points into an
-- add-on.
--
-- Only adds: three tables and three functions.
-- =============================================================================

create table addon_outreach.comment_research (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Who started it: only their browser reads for it.
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null default 'instagram' check (platform in ('instagram')),
  state text not null check (state in ('reading', 'summing', 'done', 'stopped')),
  target integer not null check (target between 100 and 10000),
  days integer not null check (days between 1 and 14),
  started_at timestamptz not null,
  kept integer not null default 0 check (kept >= 0),
  dropped integer not null default 0 check (dropped >= 0),
  posts integer not null default 0 check (posts >= 0),
  -- The hashtags read so far, so the next batch reads others.
  tags text[] not null default '{}' check (cardinality(tags) <= 400),
  findings jsonb
    check (findings is null or (jsonb_typeof(findings) = 'object' and pg_column_size(findings) <= 65536)),
  guide text check (guide is null or length(btrim(guide)) between 1 and 4000),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index comment_research_open_idx on addon_outreach.comment_research (workspace_id, platform)
  where state in ('reading', 'summing');
create index comment_research_user_idx on addon_outreach.comment_research (user_id);
select private.addon_table_policies('addon_outreach.comment_research', 'outreach.use', 'outreach.use', null, null);
create policy comment_research_staff on addon_outreach.comment_research as restrictive for all to authenticated
  using ((select private.staff_can('platform.ai.manage')))
  with check ((select private.staff_can('platform.ai.manage')));

create table addon_outreach.comment_samples (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  research_id uuid not null,
  -- The kind of post it was under (core's RESEARCH_TOPICS).
  topic text not null check (topic ~ '^[a-z_]{2,24}$'),
  -- The comment's words alone: nobody's name, no link.
  words text not null check (length(btrim(words)) between 1 and 300),
  -- md5 of the words in lower case: one row a comment's words, counted when seen again.
  words_key text not null check (words_key ~ '^[0-9a-f]{32}$'),
  seen integer not null default 1 check (seen >= 1),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (research_id, words_key),
  foreign key (workspace_id, research_id)
    references addon_outreach.comment_research (workspace_id, id) on delete cascade
);
create index comment_samples_research_idx on addon_outreach.comment_samples (workspace_id, research_id);
select private.addon_table_policies('addon_outreach.comment_samples', 'outreach.use', 'outreach.use', null, null);
create policy comment_samples_staff on addon_outreach.comment_samples as restrictive for all to authenticated
  using ((select private.staff_can('platform.ai.manage')))
  with check ((select private.staff_can('platform.ai.manage')));

-- ---------- the guide in use, for every business ----------
create table platform.comment_guides (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('instagram')),
  guide text not null check (length(btrim(guide)) between 1 and 4000),
  -- How many comments it was learned from.
  comments integer not null check (comments >= 0),
  -- The research it came from. A label, not a key.
  research_id uuid,
  used_at timestamptz not null default now(),
  used_by uuid references app.users (id) on delete set null,
  stopped_at timestamptz,
  stopped_by uuid references app.users (id) on delete set null
);
create unique index comment_guides_in_use_idx on platform.comment_guides (platform) where stopped_at is null;
create index comment_guides_used_by_idx on platform.comment_guides (used_by);
create index comment_guides_stopped_by_idx on platform.comment_guides (stopped_by);

-- The worker reads the one in use as it writes a comment; staff read it through the definer below. Nobody writes but
-- through the definers.
alter table platform.comment_guides enable row level security;
create policy comment_guides_service_select on platform.comment_guides for select to service_actor using (true);
grant select on platform.comment_guides to service_actor;
revoke all on platform.comment_guides from anon, authenticated;

-- Puts a guide in every business's comments on a network, in place of the one in use. Staff-only: it checks for
-- itself.
create function private.use_comment_guide(p_platform text, p_guide text, p_comments integer, p_research uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'Only HandsFreeOS staff choose the comment guide'
      using errcode = '42501', detail = 'comment_guide_is_ours';
  end if;
  update platform.comment_guides g
  set stopped_at = now(), stopped_by = (select auth.uid())
  where g.platform = p_platform and g.stopped_at is null;
  insert into platform.comment_guides (platform, guide, comments, research_id, used_by)
  values (p_platform, p_guide, greatest(0, coalesce(p_comments, 0)), p_research, (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

-- Takes the guide in use out of every business's comments again; how many it stopped. Staff-only.
create function private.stop_comment_guide(p_platform text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'Only HandsFreeOS staff choose the comment guide'
      using errcode = '42501', detail = 'comment_guide_is_ours';
  end if;
  update platform.comment_guides g
  set stopped_at = now(), stopped_by = (select auth.uid())
  where g.platform = p_platform and g.stopped_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The guide in use on a network, for staff.
create function private.comment_guide_in_use(p_platform text)
returns table (id uuid, platform text, guide text, comments integer, research_id uuid, used_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, g.platform, g.guide, g.comments, g.research_id, g.used_at
  from platform.comment_guides g
  where private.staff_can('platform.ai.manage') and g.platform = p_platform and g.stopped_at is null
$$;

revoke all on function
  private.use_comment_guide(text, text, integer, uuid), private.stop_comment_guide(text),
  private.comment_guide_in_use(text)
  from public;
grant execute on function
  private.use_comment_guide(text, text, integer, uuid), private.stop_comment_guide(text),
  private.comment_guide_in_use(text)
  to authenticated;
