-- =============================================================================
-- 0100 · Ideas, the roadmap and What's new.
--
--        The people who use HandsFreeOS tell us what would make it better, vote
--        on what matters to them, and follow an idea from "under review" to
--        "done". When it ships, What's new says so, and everybody who asked for
--        it hears about it by email. It is the board GoHighLevel keeps at
--        ideas.gohighlevel.com, built in rather than bolted on: we already know
--        who is asking, so nobody signs in twice.
--
--        **It lives in `platform`.** An idea belongs to HandsFreeOS, not to the
--        business it was typed in. Every business reads the same board, so no
--        tenant policy could say who may read it — and the support desk's
--        reason holds too: a schema the tenant policies never mention cannot
--        leak through one.
--
--        **Who takes part.** Anyone who works in a business here, and the
--        people who work here, read the board, share ideas, vote and comment.
--        A sign-up that never made a business does not
--        (`private.takes_part_in_ideas`).
--
--        **What other businesses see of you.** A short name ("Dale R.") beside
--        an idea or a comment you wrote, and nothing else: never an email,
--        never your business, never what you voted for. The team sees all of
--        it, because "twelve HVAC companies want this" is how a roadmap gets
--        decided.
--
--        **Two staff permissions.** `platform.ideas.moderate` (every support
--        role) answers as the team, tidies a title, merges duplicates and takes
--        down spam. `platform.ideas.manage` (leads and admins) moves an idea
--        along the roadmap — which emails everybody following it — and writes
--        What's new.
--
--        **The counts are the database's.** Votes, comments and the trending
--        score are kept by triggers from the rows behind them, and no person's
--        grant reaches those columns, so a number on the board is never one a
--        command wrote.
-- =============================================================================

-- ---------- the parts of HandsFreeOS an idea can be about ----------
-- Rows rather than an enum: a new part of the product should cost a row, not a deploy.
create table platform.idea_areas (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (length(btrim(name)) between 1 and 60),
  description text not null default '' check (length(description) <= 300),
  sort integer not null default 0,
  /** Out of the list for new ideas; the ideas already in it keep it. */
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index idea_areas_name_idx on platform.idea_areas (lower(name));
create trigger idea_areas_updated_at before update on platform.idea_areas
  for each row execute function private.set_updated_at();

insert into platform.idea_areas (id, name, description, sort) values
  ('home', 'Home and the Action Center', 'What needs attention, and the morning summary', 10),
  ('inbox', 'Inbox, texts and email', 'Talking with customers by text, email and website chat', 20),
  ('calls', 'Calls and phone numbers', 'Calling, voicemail, numbers, and bringing a number here', 30),
  ('customers', 'Customers and the pipeline', 'Customers, companies, leads, the pipeline and tasks', 40),
  ('calendar', 'Calendar and booking', 'Calendars, appointments and booking pages', 50),
  ('money', 'Money', 'Estimates, invoices, payments and plans', 60),
  ('workflows', 'Workflows and automations', 'Follow-ups that run by themselves', 70),
  ('ai_teammate', 'AI teammate and website chat', 'The AI that answers your customers', 80),
  ('assistant', 'The Assistant', 'Ask HandsFreeOS, inside the app', 90),
  ('forms', 'Forms and surveys', 'Forms, surveys and quizzes', 100),
  ('reviews', 'Reviews', 'Asking for reviews and answering them', 110),
  ('phone_app', 'The phone app', 'HandsFreeOS on iPhone and Android', 120),
  ('moving_in', 'Moving from another CRM', 'Bringing a business here from GoHighLevel and others', 130),
  ('other', 'Something else', 'Anything that fits nowhere above', 1000);

-- ---------- who takes part ----------
-- Somebody who works in a business here, or works here. It answers about the caller and nobody else.
create or replace function private.takes_part_in_ideas()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    exists (select 1 from app.workspace_memberships m where m.user_id = auth.uid())
    or exists (select 1 from app.organization_memberships m where m.user_id = auth.uid())
    or private.is_staff())
$$;

-- ---------- ideas ----------
-- `under_review` is where every idea starts; `planned` and `in_progress` are the roadmap; `done` shipped;
-- `not_planned` is a plain no, said out loud rather than left to rot.
create type platform.idea_status as enum ('under_review', 'planned', 'in_progress', 'done', 'not_planned');

create sequence platform.idea_number_seq start 1;

-- The search document: the title weighs most (A), then the details (B), in English. A function because a
-- generated column needs an immutable expression.
create or replace function private.idea_search_vector(p_title text, p_body text)
returns tsvector language sql immutable parallel safe set search_path = '' as $$
  select setweight(to_tsvector('english'::regconfig, coalesce(p_title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(p_body, '')), 'B')
$$;

create table platform.ideas (
  id uuid primary key default gen_random_uuid(),
  /** What people and the team call it: "#42". */
  number bigint not null unique default nextval('platform.idea_number_seq'),
  title text not null check (length(btrim(title)) between 3 and 140),
  body text not null default '' check (length(body) <= 5000),
  area_id text not null default 'other' references platform.idea_areas (id),
  status platform.idea_status not null default 'under_review',
  author_user_id uuid references app.users (id) on delete set null,
  /** The business it was typed in. For the team only: no other business is ever told. */
  workspace_id uuid references app.workspaces (id) on delete set null,
  vote_count integer not null default 0 check (vote_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  /**
   * How much it is being voted for lately: every vote counts one when it is cast and half as much a week
   * later, and so on (the sum as it stood at `trend_at`). "Trending" reads it decayed to now.
   */
  trend_score double precision not null default 0 check (trend_score >= 0),
  trend_at timestamptz not null default now(),
  /** A duplicate points at the idea it was folded into; its votes and followers went there too. */
  merged_into uuid references platform.ideas (id) on delete set null,
  /** Taken off the board by the team: spam, or not an idea at all. Its author and the team still see it. */
  hidden_at timestamptz,
  hidden_by uuid references app.users (id) on delete set null,
  status_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (private.idea_search_vector(title, body)) stored,
  check (merged_into is null or merged_into <> id)
);
create index ideas_board_idx on platform.ideas (status, vote_count desc, created_at desc)
  where hidden_at is null and merged_into is null;
create index ideas_created_idx on platform.ideas (created_at desc);
create index ideas_area_idx on platform.ideas (area_id);
create index ideas_author_idx on platform.ideas (author_user_id, created_at desc);
create index ideas_workspace_idx on platform.ideas (workspace_id);
create index ideas_merged_into_idx on platform.ideas (merged_into);
create index ideas_hidden_by_idx on platform.ideas (hidden_by);
create index ideas_search_idx on platform.ideas using gin (search);
-- "Is it one of these?" while someone is still typing a title: trigram similarity, typos and all.
create index ideas_title_trgm_idx on platform.ideas using gin (title extensions.gin_trgm_ops);
create trigger ideas_updated_at before update on platform.ideas
  for each row execute function private.set_updated_at();
create trigger ideas_immutable before update on platform.ideas
  for each row execute function private.forbid_tenant_column_change('number', 'created_at');

-- A person shares ten ideas a day at most. Nobody with ten real ideas in a day is stopped by it, and a script
-- that has found the button is. The team is never counted. The test is on current_user, which no role can
-- fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_new_idea()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if not private.is_staff() and (select w.ideas from private.my_recent_idea_writes(interval '1 day') w) >= 10 then
    raise exception 'That is ten ideas today. Share the next one tomorrow.'
      using errcode = '54000', detail = 'too_many_ideas';
  end if;
  return new;
end $$;
create trigger ideas_guard_new before insert on platform.ideas
  for each row execute function private.guard_new_idea();

-- Who may change what. The grants keep everybody off the counts; this keeps an author to their own words, the
-- moderators to tidying, and the roadmap itself to leads and admins. The *_at stamps are the database's clock
-- and name the person who did it. The test is on current_user, which no role can fake, so this function must
-- stay SECURITY INVOKER.
create or replace function private.guard_idea()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_words constant text[] := array['title', 'body', 'area_id', 'updated_at', 'search'];
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.status is distinct from old.status then
    if not private.staff_can('platform.ideas.manage') then
      raise exception 'Only the HandsFreeOS team moves an idea along the roadmap'
        using errcode = '42501', detail = 'idea_roadmap_is_ours';
    end if;
    new.status_changed_at := now();
  end if;
  if private.staff_can('platform.ideas.moderate') then
    if new.hidden_at is distinct from old.hidden_at then
      if new.hidden_at is null then
        new.hidden_by := null;
      else
        new.hidden_at := now();
        new.hidden_by := auth.uid();
      end if;
    end if;
    return new;
  end if;
  -- Everyone else is the author, fixing their own words before anybody here has answered them.
  if (to_jsonb(new) - v_words) is distinct from (to_jsonb(old) - v_words) then
    raise exception 'Only the HandsFreeOS team changes that about an idea'
      using errcode = '42501', detail = 'idea_protected';
  end if;
  return new;
end $$;
create trigger ideas_guard before update on platform.ideas
  for each row execute function private.guard_idea();

-- ---------- votes ----------
create table platform.idea_votes (
  idea_id uuid not null references platform.ideas (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  /** The business they voted from. For the team only, like the idea's own. */
  workspace_id uuid references app.workspaces (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);
create index idea_votes_user_idx on platform.idea_votes (user_id, created_at desc);
create index idea_votes_workspace_idx on platform.idea_votes (workspace_id);

-- ---------- following an idea ----------
-- Sharing, voting and commenting all follow an idea; "stop telling me" turns `following` off and keeps the
-- row, so a later vote never quietly undoes a choice somebody made.
create table platform.idea_followers (
  idea_id uuid not null references platform.ideas (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  following boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);
create index idea_followers_user_idx on platform.idea_followers (user_id);
create trigger idea_followers_updated_at before update on platform.idea_followers
  for each row execute function private.set_updated_at();

-- The count, the trending score and the follow, kept together. A vote adds what it is worth today — one, for a
-- vote cast now; less, for one carried over from a merged duplicate — and taking a vote back takes away exactly
-- what it is still worth, so the score never drifts from the votes behind it.
create or replace function private.count_idea_vote()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_week constant double precision := 7 * 86400;
begin
  if tg_op = 'INSERT' then
    update platform.ideas i set
      vote_count = i.vote_count + 1,
      trend_score = i.trend_score * power(0.5::float8, extract(epoch from (now() - i.trend_at))::float8 / v_week)
        + power(0.5::float8, greatest(extract(epoch from (now() - new.created_at))::float8, 0) / v_week),
      trend_at = now()
    where i.id = new.idea_id;
    -- Voting for something is asking to hear how it goes.
    insert into platform.idea_followers (idea_id, user_id) values (new.idea_id, new.user_id)
    on conflict do nothing;
    return new;
  end if;
  update platform.ideas i set
    vote_count = greatest(i.vote_count - 1, 0),
    trend_score = greatest(
      i.trend_score * power(0.5::float8, extract(epoch from (now() - i.trend_at))::float8 / v_week)
        - power(0.5::float8, greatest(extract(epoch from (now() - old.created_at))::float8, 0) / v_week),
      0),
    trend_at = now()
  where i.id = old.idea_id;
  return old;
end $$;
create trigger idea_votes_count after insert or delete on platform.idea_votes
  for each row execute function private.count_idea_vote();

-- Sharing an idea is voting for it, from the business it was shared in.
create or replace function private.vote_for_own_idea()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.author_user_id is not null then
    insert into platform.idea_votes (idea_id, user_id, workspace_id)
    values (new.id, new.author_user_id, new.workspace_id)
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger ideas_author_votes after insert on platform.ideas
  for each row execute function private.vote_for_own_idea();

-- ---------- comments ----------
create table platform.idea_comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references platform.ideas (id) on delete cascade,
  author_user_id uuid references app.users (id) on delete set null,
  /** Written by somebody on the HandsFreeOS team, and shown that way. The database decides, never the caller. */
  from_team boolean not null default false,
  body text not null check (length(btrim(body)) between 1 and 5000),
  /** Taken down, by its author or by the team. */
  hidden_at timestamptz,
  hidden_by uuid references app.users (id) on delete set null,
  /** When the idea's author was emailed about this answer from the team. The worker's alone. */
  author_told_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idea_comments_idea_idx on platform.idea_comments (idea_id, created_at);
create index idea_comments_author_idx on platform.idea_comments (author_user_id, created_at desc);
create index idea_comments_hidden_by_idx on platform.idea_comments (hidden_by);
create trigger idea_comments_updated_at before update on platform.idea_comments
  for each row execute function private.set_updated_at();

-- How much one person has written lately, for the limits below. It answers about the caller only.
create or replace function private.my_recent_idea_writes(p_since interval)
returns table (ideas bigint, comments bigint)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from platform.ideas i
      where i.author_user_id = auth.uid() and i.created_at > now() - p_since),
    (select count(*) from platform.idea_comments c
      where c.author_user_id = auth.uid() and c.created_at > now() - p_since)
$$;

-- Whether a comment is the team's is a fact about who wrote it, taken when they wrote it: somebody who joins the
-- team later does not turn their old comments official. Thirty comments an hour at most, the team aside. The
-- test is on current_user, which no role can fake, so this function must stay SECURITY INVOKER.
create or replace function private.stamp_idea_comment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  new.from_team := private.is_staff();
  new.hidden_at := null;
  new.hidden_by := null;
  if not new.from_team
     and (select w.comments from private.my_recent_idea_writes(interval '1 hour') w) >= 30 then
    raise exception 'That is a lot of comments in an hour. Give it a little while.'
      using errcode = '54000', detail = 'too_many_idea_comments';
  end if;
  return new;
end $$;
create trigger idea_comments_stamp before insert on platform.idea_comments
  for each row execute function private.stamp_idea_comment();

-- A comment's words never change once posted. Its author may take it down; the team may take it down or put it
-- back. The test is on current_user, which no role can fake, so this function must stay SECURITY INVOKER.
create or replace function private.guard_idea_comment()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_takedown constant text[] := array['hidden_at', 'hidden_by', 'updated_at'];
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if (to_jsonb(new) - v_takedown) is distinct from (to_jsonb(old) - v_takedown) then
    raise exception 'A comment can be taken down, not changed'
      using errcode = '42501', detail = 'idea_comment_protected';
  end if;
  if new.hidden_at is distinct from old.hidden_at then
    if new.hidden_at is not null and old.hidden_at is null
       and (old.author_user_id = auth.uid() or private.staff_can('platform.ideas.moderate')) then
      new.hidden_at := now();
      new.hidden_by := auth.uid();
    elsif new.hidden_at is null and private.staff_can('platform.ideas.moderate') then
      new.hidden_by := null;
    else
      raise exception 'Only the HandsFreeOS team puts a comment back'
        using errcode = '42501', detail = 'idea_comment_protected';
    end if;
  elsif new.hidden_by is distinct from old.hidden_by then
    raise exception 'A comment can be taken down, not changed'
      using errcode = '42501', detail = 'idea_comment_protected';
  end if;
  return new;
end $$;
create trigger idea_comments_guard before update on platform.idea_comments
  for each row execute function private.guard_idea_comment();

-- The count on the board is of the comments people can read; commenting follows the idea.
create or replace function private.count_idea_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_delta integer := 0;
begin
  if tg_op = 'INSERT' then
    if new.hidden_at is null then
      v_delta := 1;
    end if;
    if new.author_user_id is not null then
      insert into platform.idea_followers (idea_id, user_id) values (new.idea_id, new.author_user_id)
      on conflict do nothing;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.hidden_at is null and new.hidden_at is not null then
      v_delta := -1;
    elsif old.hidden_at is not null and new.hidden_at is null then
      v_delta := 1;
    end if;
  end if;
  if v_delta <> 0 then
    update platform.ideas i set comment_count = greatest(i.comment_count + v_delta, 0)
    where i.id = new.idea_id;
  end if;
  return new;
end $$;
create trigger idea_comments_count after insert or update of hidden_at on platform.idea_comments
  for each row execute function private.count_idea_comment();

-- ---------- What's new ----------
create type platform.whats_new_kind as enum ('new', 'improved', 'fixed');

create table platform.whats_new (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 3 and 140),
  /** Plain text: paragraphs, and lines that start "- " as a list. Never HTML. */
  body text not null default '' check (length(body) <= 20000),
  kind platform.whats_new_kind not null default 'new',
  area_id text references platform.idea_areas (id),
  /** Null while it is a draft only the team can see. */
  published_at timestamptz,
  author_user_id uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index whats_new_published_idx on platform.whats_new (published_at desc) where published_at is not null;
create index whats_new_area_idx on platform.whats_new (area_id);
create index whats_new_author_idx on platform.whats_new (author_user_id);
create trigger whats_new_updated_at before update on platform.whats_new
  for each row execute function private.set_updated_at();

-- The ideas an entry delivers: "asked for in …" under it, and the people who asked hear about it.
create table platform.whats_new_ideas (
  whats_new_id uuid not null references platform.whats_new (id) on delete cascade,
  idea_id uuid not null references platform.ideas (id) on delete cascade,
  primary key (whats_new_id, idea_id)
);
create index whats_new_ideas_idea_idx on platform.whats_new_ideas (idea_id);

-- When each person last looked at What's new, so the menu can say there is something they have not seen.
create table platform.whats_new_reads (
  user_id uuid primary key references app.users (id) on delete cascade,
  seen_at timestamptz not null default now()
);

-- ---------- what happened to an idea ----------
-- The story under an idea, as the people following it read it: moved to Planned (with what the team said),
-- merged, shipped. A status row is also what the worker emails the followers about.
create type platform.idea_update_kind as enum ('status', 'merged', 'merged_in');

create table platform.idea_updates (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references platform.ideas (id) on delete cascade,
  kind platform.idea_update_kind not null,
  from_status platform.idea_status,
  to_status platform.idea_status,
  /** What the team told the people following it: on the idea, and in the email. */
  note text not null default '' check (length(note) <= 2000),
  /** The other idea in a merge: where a duplicate went, or where one came from. */
  other_idea_id uuid references platform.ideas (id) on delete set null,
  /** The What's new entry that shipped it. */
  whats_new_id uuid references platform.whats_new (id) on delete set null,
  /** Whether the followers are to be told. The worker says when it has. */
  notify boolean not null default true,
  notified_at timestamptz,
  actor_user_id uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- A merge names the other idea too, but not as a check: that idea may be deleted later, and its line in
  -- this story stays, saying only that there was one.
  check (kind <> 'status' or to_status is not null)
);
create index idea_updates_idea_idx on platform.idea_updates (idea_id, created_at);
create index idea_updates_other_idx on platform.idea_updates (other_idea_id);
create index idea_updates_whats_new_idx on platform.idea_updates (whats_new_id);
create index idea_updates_actor_idx on platform.idea_updates (actor_user_id);

-- One row per person told about one update, so a retry after a failed send carries on where it stopped rather
-- than telling the first half twice. The worker's alone.
create table platform.idea_update_deliveries (
  update_id uuid not null references platform.idea_updates (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (update_id, user_id)
);
create index idea_update_deliveries_user_idx on platform.idea_update_deliveries (user_id);

-- ---------- merging a duplicate ----------
-- The duplicate points at the idea it joins, and its followers and votes are copied across: followers first, so
-- somebody who had said "stop telling me" is not followed again by their own vote arriving. A vote already on
-- the other idea stays one vote. Anything merged into the duplicate earlier now points at the same place, so a
-- merge is never a chain. Everybody's vote on the duplicate stays where it was too, as its history.
create or replace function private.merge_idea(p_idea uuid, p_into uuid)
returns table (moved_votes integer, moved_followers integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_idea platform.ideas;
  v_into platform.ideas;
  v_votes integer;
  v_followers integer;
begin
  if not private.staff_can('platform.ideas.moderate') then
    raise exception 'Only the HandsFreeOS team merges ideas' using errcode = '42501', detail = 'idea_protected';
  end if;
  if p_idea = p_into then
    raise exception 'An idea cannot be merged into itself' using errcode = '22023', detail = 'idea_merge_itself';
  end if;
  -- Both rows locked, in one order, so two merges crossing each other wait rather than deadlock.
  perform 1 from platform.ideas i where i.id in (p_idea, p_into) order by i.id for update;
  select * into v_idea from platform.ideas i where i.id = p_idea;
  select * into v_into from platform.ideas i where i.id = p_into;
  if v_idea.id is null or v_into.id is null then
    raise exception 'Idea not found' using errcode = '42704', detail = 'idea_not_found';
  end if;
  if v_idea.merged_into is not null then
    raise exception 'That idea was already merged' using errcode = '23514', detail = 'idea_already_merged';
  end if;
  if v_into.merged_into is not null or v_into.hidden_at is not null then
    raise exception 'Merge it into an idea that is still on the board'
      using errcode = '23514', detail = 'idea_merge_target_gone';
  end if;
  update platform.ideas i set merged_into = p_into where i.id = p_idea or i.merged_into = p_idea;
  with moved as (
    insert into platform.idea_followers (idea_id, user_id, following)
    select p_into, f.user_id, f.following from platform.idea_followers f where f.idea_id = p_idea
    on conflict do nothing
    returning 1)
  select count(*)::int into v_followers from moved;
  with moved as (
    insert into platform.idea_votes (idea_id, user_id, workspace_id, created_at)
    select p_into, v.user_id, v.workspace_id, v.created_at from platform.idea_votes v where v.idea_id = p_idea
    on conflict do nothing
    returning 1)
  select count(*)::int into v_votes from moved;
  return query select v_votes, v_followers;
end $$;

-- ---------- names, as other businesses see them ----------
-- "Dale Ramsey" is "Dale R." to everybody outside Dale's business: enough to tell two people apart in a thread,
-- not enough to look anybody up.
create or replace function private.short_name(p_full text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case
    when coalesce(btrim(p_full), '') = '' then ''
    when btrim(p_full) !~ '\s' then btrim(p_full)
    else split_part(btrim(p_full), ' ', 1) || ' ' || left(regexp_replace(btrim(p_full), '^.*\s', ''), 1) || '.'
  end
$$;

-- The names to show beside ideas, comments and updates. Only for people who wrote one of those — this is not a
-- directory of everybody on HandsFreeOS — and only to someone who takes part. The team's own people go by the
-- name they chose for the support desk. Somebody who deleted their account has no name at all.
create or replace function private.idea_people(p_ids uuid[])
returns table (user_id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select u.id,
    case
      when u.deleted_at is not null then ''
      when s.user_id is not null and btrim(s.display_name) <> '' then btrim(s.display_name)
      else private.short_name(u.full_name)
    end
  from app.users u
  left join platform.staff s on s.user_id = u.id and s.status = 'active'
  where u.id = any(p_ids)
    and private.takes_part_in_ideas()
    and (exists (select 1 from platform.ideas i where i.author_user_id = u.id)
      or exists (select 1 from platform.idea_comments c where c.author_user_id = u.id)
      or exists (select 1 from platform.idea_updates d where d.actor_user_id = u.id))
$$;

-- ---------- who to tell ----------
-- The worker holds no business while it sends these, so it cannot read app.users; this answers the one question
-- it has. The people following the idea an update is about, who still take part, other than whoever made the
-- update, and not yet told about it.
create or replace function private.idea_followers_to_tell(p_update uuid)
returns table (user_id uuid, email text, first_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email::text, split_part(btrim(u.full_name), ' ', 1)
  from platform.idea_updates d
  join platform.idea_followers f on f.idea_id = d.idea_id and f.following
  join app.users u on u.id = f.user_id
  where d.id = p_update
    and u.deleted_at is null
    and u.id is distinct from d.actor_user_id
    and (exists (select 1 from app.workspace_memberships m where m.user_id = u.id)
      or exists (select 1 from app.organization_memberships m where m.user_id = u.id)
      or exists (select 1 from platform.staff s where s.user_id = u.id and s.status = 'active'))
    and not exists (select 1 from platform.idea_update_deliveries x where x.update_id = d.id and x.user_id = u.id)
  order by u.id
$$;

-- Whoever shared an idea, when the team answers it in the comments: if they still follow it and still take part.
create or replace function private.idea_author_to_tell(p_idea uuid)
returns table (user_id uuid, email text, first_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email::text, split_part(btrim(u.full_name), ' ', 1)
  from platform.ideas i
  join platform.idea_followers f on f.idea_id = i.id and f.user_id = i.author_user_id and f.following
  join app.users u on u.id = i.author_user_id
  where i.id = p_idea
    and u.deleted_at is null
    and (exists (select 1 from app.workspace_memberships m where m.user_id = u.id)
      or exists (select 1 from app.organization_memberships m where m.user_id = u.id)
      or exists (select 1 from platform.staff s where s.user_id = u.id and s.status = 'active'))
$$;

-- ---------- the staff permissions ----------
insert into app.role_permissions (role, permission) values
  ('staff_agent', 'platform.ideas.moderate'),
  ('staff_lead', 'platform.ideas.moderate'), ('staff_lead', 'platform.ideas.manage'),
  ('staff_admin', 'platform.ideas.moderate'), ('staff_admin', 'platform.ideas.manage');

-- ---------- row level security ----------
alter table platform.idea_areas enable row level security;
alter table platform.ideas enable row level security;
alter table platform.idea_votes enable row level security;
alter table platform.idea_followers enable row level security;
alter table platform.idea_comments enable row level security;
alter table platform.whats_new enable row level security;
alter table platform.whats_new_ideas enable row level security;
alter table platform.whats_new_reads enable row level security;
alter table platform.idea_updates enable row level security;
alter table platform.idea_update_deliveries enable row level security;

create policy idea_areas_read on platform.idea_areas for select to authenticated
  using ((select private.takes_part_in_ideas()));
create policy idea_areas_write on platform.idea_areas for all to authenticated
  using ((select private.staff_can('platform.ideas.manage')))
  with check ((select private.staff_can('platform.ideas.manage')));
create policy idea_areas_service on platform.idea_areas for all to service_actor
  using (true) with check (true);

-- The board, for everybody who takes part; a taken-down idea for its author and the team.
create policy ideas_read on platform.ideas for select to authenticated
  using ((hidden_at is null and (select private.takes_part_in_ideas()))
    or author_user_id = (select auth.uid())
    or (select private.staff_can('platform.ideas.moderate')));
-- Shared in your own name, from a business you really work in (not one you are only looking at).
create policy ideas_share on platform.ideas for insert to authenticated
  with check (author_user_id = (select auth.uid()) and (select private.takes_part_in_ideas())
    and (workspace_id is null or private.effective_workspace_role(workspace_id) is not null));
-- An author fixes their own words while nobody here has answered them yet (private.guard_idea holds the rest).
create policy ideas_author_edit on platform.ideas for update to authenticated
  using (author_user_id = (select auth.uid()) and status = 'under_review' and hidden_at is null
    and merged_into is null)
  with check (author_user_id = (select auth.uid()) and status = 'under_review' and hidden_at is null
    and merged_into is null);
create policy ideas_team on platform.ideas for update to authenticated
  using ((select private.staff_can('platform.ideas.moderate')))
  with check ((select private.staff_can('platform.ideas.moderate')));
create policy ideas_service on platform.ideas for all to service_actor
  using (true) with check (true);

-- What you voted for is yours to know; who voted for what is the team's. Voting is for an idea still open.
create policy idea_votes_read on platform.idea_votes for select to authenticated
  using (user_id = (select auth.uid()) or (select private.staff_can('platform.ideas.moderate')));
create policy idea_votes_cast on platform.idea_votes for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.takes_part_in_ideas())
    and (workspace_id is null or private.effective_workspace_role(workspace_id) is not null)
    and exists (select 1 from platform.ideas i
      where i.id = idea_id and i.hidden_at is null and i.merged_into is null
        and i.status not in ('done', 'not_planned')));
create policy idea_votes_take_back on platform.idea_votes for delete to authenticated
  using (user_id = (select auth.uid()));
create policy idea_votes_service on platform.idea_votes for all to service_actor
  using (true) with check (true);

create policy idea_followers_read on platform.idea_followers for select to authenticated
  using (user_id = (select auth.uid()) or (select private.staff_can('platform.ideas.moderate')));
create policy idea_followers_join on platform.idea_followers for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.takes_part_in_ideas())
    and exists (select 1 from platform.ideas i where i.id = idea_id));
create policy idea_followers_choose on platform.idea_followers for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy idea_followers_service on platform.idea_followers for all to service_actor
  using (true) with check (true);

-- Comments on an idea you can read; a taken-down one for its author and the team.
create policy idea_comments_read on platform.idea_comments for select to authenticated
  using ((hidden_at is null and (select private.takes_part_in_ideas())
      and exists (select 1 from platform.ideas i where i.id = idea_id))
    or author_user_id = (select auth.uid())
    or (select private.staff_can('platform.ideas.moderate')));
create policy idea_comments_write on platform.idea_comments for insert to authenticated
  with check (author_user_id = (select auth.uid()) and (select private.takes_part_in_ideas())
    and exists (select 1 from platform.ideas i where i.id = idea_id and i.merged_into is null));
create policy idea_comments_take_down on platform.idea_comments for update to authenticated
  using (author_user_id = (select auth.uid()) or (select private.staff_can('platform.ideas.moderate')))
  with check (author_user_id = (select auth.uid()) or (select private.staff_can('platform.ideas.moderate')));
create policy idea_comments_service on platform.idea_comments for all to service_actor
  using (true) with check (true);

create policy whats_new_read on platform.whats_new for select to authenticated
  using ((published_at is not null and (select private.takes_part_in_ideas()))
    or (select private.staff_can('platform.ideas.manage')));
create policy whats_new_write on platform.whats_new for all to authenticated
  using ((select private.staff_can('platform.ideas.manage')))
  with check ((select private.staff_can('platform.ideas.manage')));
create policy whats_new_service on platform.whats_new for all to service_actor
  using (true) with check (true);

create policy whats_new_ideas_read on platform.whats_new_ideas for select to authenticated
  using (exists (select 1 from platform.whats_new w where w.id = whats_new_id)
    and exists (select 1 from platform.ideas i where i.id = idea_id));
create policy whats_new_ideas_write on platform.whats_new_ideas for all to authenticated
  using ((select private.staff_can('platform.ideas.manage')))
  with check ((select private.staff_can('platform.ideas.manage')));
create policy whats_new_ideas_service on platform.whats_new_ideas for all to service_actor
  using (true) with check (true);

create policy whats_new_reads_mine on platform.whats_new_reads for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy whats_new_reads_service on platform.whats_new_reads for all to service_actor
  using (true) with check (true);

create policy idea_updates_read on platform.idea_updates for select to authenticated
  using (((select private.takes_part_in_ideas()) and exists (select 1 from platform.ideas i where i.id = idea_id))
    or (select private.staff_can('platform.ideas.moderate')));
-- Written in your own name: a status by a lead or admin, a merge by any moderator.
create policy idea_updates_write on platform.idea_updates for insert to authenticated
  with check (actor_user_id = (select auth.uid()) and (
    (kind = 'status' and (select private.staff_can('platform.ideas.manage')))
    or (kind <> 'status' and (select private.staff_can('platform.ideas.moderate')))));
create policy idea_updates_service on platform.idea_updates for all to service_actor
  using (true) with check (true);

create policy idea_update_deliveries_service on platform.idea_update_deliveries for all to service_actor
  using (true) with check (true);

-- ---------- grants ----------
-- Reading is by policy. Writing is by column: nobody's grant reaches a count, a stamp or who wrote something.
grant select on platform.idea_areas, platform.ideas, platform.idea_votes, platform.idea_followers,
  platform.idea_comments, platform.whats_new, platform.whats_new_ideas, platform.whats_new_reads,
  platform.idea_updates to authenticated;
grant insert, update, delete on platform.idea_areas to authenticated;
grant insert (title, body, area_id, author_user_id, workspace_id) on platform.ideas to authenticated;
grant update (title, body, area_id, status, merged_into, hidden_at) on platform.ideas to authenticated;
grant insert (idea_id, user_id, workspace_id), delete on platform.idea_votes to authenticated;
grant insert (idea_id, user_id, following), update (following) on platform.idea_followers to authenticated;
grant insert (idea_id, author_user_id, body), update (hidden_at) on platform.idea_comments to authenticated;
grant insert, update, delete on platform.whats_new, platform.whats_new_ideas to authenticated;
grant insert (user_id, seen_at), update (seen_at) on platform.whats_new_reads to authenticated;
grant insert (idea_id, kind, from_status, to_status, note, other_idea_id, whats_new_id, notify, actor_user_id)
  on platform.idea_updates to authenticated;
grant usage on sequence platform.idea_number_seq to authenticated, service_actor;

grant select, insert, update, delete on platform.idea_areas, platform.ideas, platform.idea_votes,
  platform.idea_followers, platform.idea_comments, platform.whats_new, platform.whats_new_ideas,
  platform.whats_new_reads, platform.idea_updates, platform.idea_update_deliveries to service_actor;

revoke all on function
  private.takes_part_in_ideas(), private.idea_search_vector(text, text), private.my_recent_idea_writes(interval),
  private.guard_new_idea(), private.guard_idea(), private.count_idea_vote(), private.vote_for_own_idea(),
  private.stamp_idea_comment(), private.guard_idea_comment(), private.count_idea_comment(),
  private.merge_idea(uuid, uuid), private.short_name(text), private.idea_people(uuid[]),
  private.idea_followers_to_tell(uuid), private.idea_author_to_tell(uuid)
  from public;
grant execute on function
  private.takes_part_in_ideas(), private.idea_search_vector(text, text), private.my_recent_idea_writes(interval),
  private.guard_new_idea(), private.guard_idea(), private.count_idea_vote(), private.vote_for_own_idea(),
  private.stamp_idea_comment(), private.guard_idea_comment(), private.count_idea_comment(),
  private.short_name(text)
  to authenticated, service_actor;
grant execute on function private.merge_idea(uuid, uuid), private.idea_people(uuid[]) to authenticated;
grant execute on function private.idea_followers_to_tell(uuid), private.idea_author_to_tell(uuid)
  to service_actor;
