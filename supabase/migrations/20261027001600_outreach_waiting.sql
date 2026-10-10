-- =============================================================================
-- Social Outreach (outreach): Waiting for you (docs/outreach.md, decisions 40
-- and 42).
--
--        `sends` says which waiting replies were handed over to the person
--        (Replies (b) or (c), and it wasn't simple or they need the person),
--        and why a reply needs them. Both wait to be OK'd one at a time.
--
--        `friends` keeps when the person set a friend request aside, so it
--        leaves Waiting for you; a request that comes again is back.
--
--        `needs` keeps each step the extension couldn't do and handed to the
--        person: what it was, who, where, and why; open until they did it,
--        let it go, or the step was noted. Its names and reasons are the
--        person's own, on the database too (see the end).
--
--        `waiting_pushes` keeps when each person last got the bundled push
--        about what waits, so it goes at most every 2 hours.
--
-- Only adds: nothing is dropped. Replies waiting already, of people whose
-- settings hand replies over, are marked handed over, as they were pushed.
-- =============================================================================

alter table addon_outreach.sends
  add column handed_over boolean not null default false,
  add column needs_you text check (needs_you is null or char_length(needs_you) <= 300);

update addon_outreach.sends s set handed_over = true
  from addon_outreach.automation a
  where a.workspace_id = s.workspace_id and a.user_id = s.user_id
    and s.state = 'waiting' and s.kind = 'reply'
    and a.sending <> 'off' and a.replies <> 'draft'
    and (a.wheels_from is null or a.wheels_done_at is not null);

alter table addon_outreach.friends
  add column set_aside_at timestamptz;

create table addon_outreach.needs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- What it was doing: Today's kind for a step, or a message that didn't go.
  step text not null check (step in ('confirm', 'friend_request', 'warm_up', 'comment', 'message')),
  profile_id uuid not null,
  post_id uuid,
  send_id uuid,
  -- Who, and where to do it: their profile, the post, or the chat.
  name text not null check (char_length(name) between 1 and 200),
  url text check (url is null or char_length(url) <= 500),
  -- Why it couldn't, in the extension's words.
  why text not null check (char_length(why) between 1 and 300),
  state text not null default 'open' check (state in ('open', 'done', 'dismissed')),
  -- The last time it couldn't: a need is shown for a week from then.
  seen_at timestamptz not null,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((state = 'open') = (cleared_at is null)),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, post_id) references addon_outreach.posts (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, send_id) references addon_outreach.sends (workspace_id, id)
    on delete set null (send_id)
);
-- The same step for the same person or post, passed over again, is the same need.
create unique index needs_open_idx on addon_outreach.needs
  (workspace_id, user_id, step, coalesce(post_id, profile_id)) where state = 'open';
create index needs_user_idx on addon_outreach.needs (workspace_id, user_id, state, seen_at desc);
create index needs_profile_idx on addon_outreach.needs (profile_id);
create index needs_post_idx on addon_outreach.needs (post_id);
create index needs_send_idx on addon_outreach.needs (send_id);
select private.addon_table_policies('addon_outreach.needs', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.waiting_pushes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  pushed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id)
);
select private.addon_table_policies('addon_outreach.waiting_pushes', 'outreach.use', 'outreach.use', null, null);

-- Each person's own, on the database too: a person reads and writes only
-- their own needs and pushes. A need names who and why, so owners and admins
-- (outreach.manage) count the team's only through
-- private.outreach_needs_waiting below (outreach.live.team), never read or
-- change them. The worker runs as service_actor, which these don't narrow.
create policy needs_own_read on addon_outreach.needs as restrictive for select to authenticated
  using (user_id = (select auth.uid()));
create policy needs_own_insert on addon_outreach.needs as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy needs_own_update on addon_outreach.needs as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy waiting_pushes_own on addon_outreach.waiting_pushes as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- A need shown in Waiting for you (ops/waiting.ts): open, the extension
-- couldn't do it since p_since (a week, NEED_SHOWN_DAYS), and the step not
-- taken some other way since (a request answered, or one sent, as Facebook's
-- lists showed). One copy, for the person's list and everyone's counts.
create or replace function private.outreach_need_shown(
  p_ws uuid, p_user uuid, p_profile uuid, p_step text, p_state text, p_seen_at timestamptz, p_since timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_state = 'open' and p_seen_at >= p_since
    and not exists (select 1 from addon_outreach.friends f
      where f.workspace_id = p_ws and f.user_id = p_user and f.profile_id = p_profile
        and ((p_step = 'confirm' and f.state <> 'request_received')
          or (p_step = 'friend_request' and f.state in ('request_sent', 'friends'))))
$$;

-- How many needs each person has shown, and the newest, for the team view
-- and Waiting for you's counts: owners and admins count anyone's, a person
-- only their own (private.outreach_may_count). Never a need's words.
create or replace function private.outreach_needs_waiting(p_ws uuid, p_users uuid[], p_since timestamptz)
returns table (user_id uuid, n int, newest timestamptz)
language sql stable security definer set search_path = '' as $$
  select n.user_id, count(*)::int, max(n.created_at)
  from addon_outreach.needs n
  where n.workspace_id = p_ws and n.user_id = any (p_users) and n.state = 'open'
    and private.outreach_may_count(p_ws, p_users)
    and private.outreach_need_shown(n.workspace_id, n.user_id, n.profile_id, n.step, n.state, n.seen_at, p_since)
  group by n.user_id
$$;
revoke all on function private.outreach_need_shown(uuid, uuid, uuid, text, text, timestamptz, timestamptz) from public;
revoke all on function private.outreach_needs_waiting(uuid, uuid[], timestamptz) from public;
grant execute on function private.outreach_need_shown(uuid, uuid, uuid, text, text, timestamptz, timestamptz)
  to authenticated, service_actor;
grant execute on function private.outreach_needs_waiting(uuid, uuid[], timestamptz) to authenticated, service_actor;
