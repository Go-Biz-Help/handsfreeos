-- =============================================================================
-- Social Outreach (outreach): asking the extension (docs/outreach.md,
-- decision 43).
--
--        `asks` keeps each thing a person asked their computer to do on
--        Facebook from HandsFreeOS: get their Facebook file, check their
--        friend requests, save their friends, groups or a group's members,
--        find posts, read their chats, cancel or unfriend the people they
--        ticked, or look someone up before drafting. The computer that
--        works for them takes it, says how it's going, hands a step to the
--        person when it can't find it, and says how it ended. Its lines name
--        people the person reached, so each person's are their own, on the
--        database too (see the end).
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.asks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  kind text not null check (kind in (
    'file_request', 'file_download', 'file_backup', 'file_in',
    'requests', 'friends', 'groups', 'group_search', 'members', 'posts', 'chats',
    'cancel', 'unfriend', 'lookup')),
  -- What it's about, so the same thing asked twice is the same ask: the person looked up, the groups, the words.
  target text not null default '' check (char_length(target) <= 600),
  -- What to do, as HandsFreeOS worked it out when asked: the groups, the people ticked, the words, who to look up.
  task jsonb not null default '{}'::jsonb
    check (jsonb_typeof(task) = 'object' and pg_column_size(task) <= 32768),
  -- Who or what it's about, for the lists: a group's name, "3 people", their name.
  about text check (about is null or char_length(about) <= 200),
  via text not null check (via in ('web', 'mobile', 'extension')),
  state text not null default 'waiting'
    check (state in ('waiting', 'working', 'stuck', 'typing', 'done', 'failed', 'cancelled')),
  line text check (line is null or char_length(line) <= 300),
  -- What came of it beyond the line: a look-up's drafts.
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  -- The person's answer to a step handed to them, until the computer takes it.
  reply text check (reply is null or reply in ('carry_on', 'skip')),
  computer_id uuid,
  asked_at timestamptz not null,
  started_at timestamptz,
  ended_at timestamptz,
  -- When the app was last told of a new line alone (a line is told at most every 20 seconds).
  told_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((state in ('done', 'failed', 'cancelled')) = (ended_at is not null)),
  check (state in ('waiting', 'failed', 'cancelled') or started_at is not null),
  foreign key (workspace_id, computer_id) references addon_outreach.computers (workspace_id, id)
    on delete set null (computer_id)
);
create index asks_user_idx on addon_outreach.asks (workspace_id, user_id, asked_at desc);
create index asks_open_idx on addon_outreach.asks (workspace_id, user_id, kind, asked_at)
  where state in ('waiting', 'working', 'stuck', 'typing');
create index asks_computer_idx on addon_outreach.asks (computer_id);
select private.addon_table_policies('addon_outreach.asks', 'outreach.use', 'outreach.use', null, null);

-- Each person's own, on the database too: a person reads and writes only
-- their own asks. An ask's task, line and result (a look-up's drafted
-- messages) name the people reached, so owners and admins (outreach.manage)
-- count the team's only through private.outreach_asks_waiting below
-- (outreach.live.team), never read or change them. The worker runs as
-- service_actor, which these don't narrow.
create policy asks_own_read on addon_outreach.asks as restrictive for select to authenticated
  using (user_id = (select auth.uid()));
create policy asks_own_insert on addon_outreach.asks as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy asks_own_update on addon_outreach.asks as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- How many asks wait on each person at their computer (a step handed over,
-- or their password: p_states), and the newest, for the team view and Waiting
-- for you's counts: only those whose computer was seen since p_seen_since and
-- that started since p_started_since (ops/ask-rows.ts). Owners and admins
-- count anyone's, a person only their own (private.outreach_may_count); never
-- an ask's task, line or result.
create or replace function private.outreach_asks_waiting(
  p_ws uuid, p_users uuid[], p_states text[], p_seen_since timestamptz, p_started_since timestamptz)
returns table (user_id uuid, n int, newest timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.user_id, count(*)::int, max(a.updated_at)
  from addon_outreach.asks a
  join addon_outreach.computers c on c.id = a.computer_id
  where a.workspace_id = p_ws and a.user_id = any (p_users) and a.state = any (p_states)
    and c.last_seen_at >= p_seen_since and a.started_at >= p_started_since
    and private.outreach_may_count(p_ws, p_users)
  group by a.user_id
$$;
revoke all on function private.outreach_asks_waiting(uuid, uuid[], text[], timestamptz, timestamptz) from public;
grant execute on function private.outreach_asks_waiting(uuid, uuid[], text[], timestamptz, timestamptz)
  to authenticated, service_actor;
