-- =============================================================================
-- Voting on what's next.
--
--        The owner's decisions (2026-09-28). The catalogue lists every add-on
--        HandsFreeOS plans to build (packages/core/src/addons/planned.ts), and
--        businesses vote on which comes next:
--
--        - **One vote per business**, on as many planned add-ons as it likes.
--          Its owners and admins (addons.manage) cast it and take it back.
--        - **Votes never expire.** Every Sunday at midnight, US Eastern, the
--          planned add-on with the most votes becomes Coming soon and leaves
--          the race. Nothing voted for, or a tie: nothing is set, and the team
--          is emailed to choose (for a tie, among the tied ones).
--        - **Coming soon stays until it ships**, so it can hold several.
--        - **Voters hear about it**: the owners and admins of every business
--          that voted, by email and on Home, when it is picked and again when
--          they can add it.
--
--        It lives in `platform`, beside the ideas board: a vote is about
--        HandsFreeOS's own roadmap, not the business's data. The catalogue is
--        code, so the database never decides what is planned; it keeps the
--        votes, the counts, the weeks and the picks, and the worker tells it
--        which add-ons are still in the race when a week closes.
-- =============================================================================

-- ---------- votes ----------
create table platform.addon_votes (
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  /** Who pressed it, for the team. The vote is the business's. */
  voted_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (addon_id, workspace_id)
);
create index addon_votes_workspace_idx on platform.addon_votes (workspace_id);
create index addon_votes_voted_by_idx on platform.addon_votes (voted_by);

-- The count beside each add-on, kept by the trigger below and written by nobody else, so a number on the page is
-- never one a command wrote.
create table platform.addon_vote_counts (
  addon_id text primary key check (addon_id ~ '^[a-z]{2,16}$'),
  votes integer not null default 0 check (votes >= 0),
  last_vote_at timestamptz
);

create or replace function private.count_addon_vote()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into platform.addon_vote_counts (addon_id, votes, last_vote_at)
    values (new.addon_id, 1, new.created_at)
    on conflict (addon_id) do update set
      votes = platform.addon_vote_counts.votes + 1,
      last_vote_at = greatest(platform.addon_vote_counts.last_vote_at, excluded.last_vote_at);
    return new;
  end if;
  update platform.addon_vote_counts set votes = greatest(votes - 1, 0) where addon_id = old.addon_id;
  return old;
end $$;
create trigger addon_votes_count after insert or delete on platform.addon_votes
  for each row execute function private.count_addon_vote();

-- ---------- the weeks ----------
-- One row per week that closed: how it closed, and what it picked. `votes` means one add-on had the most votes and
-- is picked; `no_votes` and `tie` wait for the team, who choose on /admin.
create table platform.addon_vote_weeks (
  id uuid primary key default gen_random_uuid(),
  /** Sunday at midnight, US Eastern: the moment the week closed. */
  ends_at timestamptz not null unique,
  outcome text not null check (outcome in ('votes', 'no_votes', 'tie')),
  /** The pick: the winner, or what the team chose. Null while a week waits for the team. */
  addon_id text check (addon_id ~ '^[a-z]{2,16}$'),
  /** For a tie, the add-ons that tied: the team chooses among them. */
  tied text[] not null default '{}',
  /** The most votes any add-on in the race had. */
  top_votes integer not null default 0,
  decided_at timestamptz,
  /** The person who chose, for a week the team decided. */
  decided_by uuid references app.users (id) on delete set null,
  /** When the team was emailed to choose. The worker's. */
  team_told_at timestamptz,
  created_at timestamptz not null default now(),
  check (outcome <> 'votes' or (addon_id is not null and decided_by is null)),
  check (outcome <> 'tie' or cardinality(tied) > 1),
  check ((addon_id is null) = (decided_at is null))
);
create index addon_vote_weeks_decided_by_idx on platform.addon_vote_weeks (decided_by);
create index addon_vote_weeks_waiting_idx on platform.addon_vote_weeks (ends_at desc) where addon_id is null;

-- ---------- Coming soon ----------
-- Everything picked, and where it has got to. Coming soon is every pick that can't be added yet; it ships when
-- the catalogue makes it available, which the worker notices and writes down.
create table platform.addon_picks (
  addon_id text primary key check (addon_id ~ '^[a-z]{2,16}$'),
  /** `votes` won a week; `team` was chosen when a week had no winner; `plan` was already HandsFreeOS's next. */
  how text not null check (how in ('votes', 'team', 'plan')),
  week_id uuid references platform.addon_vote_weeks (id) on delete set null,
  /** Its votes when it was picked. */
  votes integer not null default 0 check (votes >= 0),
  picked_at timestamptz not null default now(),
  picked_by uuid references app.users (id) on delete set null,
  /** When the businesses that voted were told it's coming soon. The worker's. */
  voters_told_at timestamptz,
  /** When it became available to add. The worker's. */
  shipped_at timestamptz,
  /** When the businesses that voted were told they can add it. The worker's. */
  shipped_told_at timestamptz
);
create index addon_picks_week_idx on platform.addon_picks (week_id);
create index addon_picks_picked_by_idx on platform.addon_picks (picked_by);

-- One row per person told about one pick, so a retry after a failed send carries on where it stopped rather than
-- telling the first half twice. The worker's alone.
create table platform.addon_pick_deliveries (
  addon_id text not null references platform.addon_picks (addon_id) on delete cascade,
  kind text not null check (kind in ('picked', 'shipped')),
  user_id uuid not null references app.users (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (addon_id, kind, user_id)
);
create index addon_pick_deliveries_user_idx on platform.addon_pick_deliveries (user_id);

-- The note on Home, set aside: each person's own, once for each pick and each kind of news.
create table platform.addon_news_seen (
  user_id uuid not null references app.users (id) on delete cascade,
  addon_id text not null references platform.addon_picks (addon_id) on delete cascade,
  kind text not null check (kind in ('picked', 'shipped')),
  seen_at timestamptz not null default now(),
  primary key (user_id, addon_id, kind)
);
create index addon_news_seen_addon_idx on platform.addon_news_seen (addon_id);

-- Real Estate Agent was HandsFreeOS's next add-on before any vote (docs/addon-architecture.md, "Not yet"): it is
-- Coming soon from the start, with nobody to tell.
insert into platform.addon_picks (addon_id, how, voters_told_at) values ('realestate', 'plan', now())
on conflict do nothing;

-- ---------- closing a week ----------
-- The worker closes each week with the add-ons still in the race (planned in the catalogue, not yet picked).
-- Closing the same week twice returns the first answer. The winner is picked here, in the same transaction.
create or replace function private.close_addon_vote_week(p_ends_at timestamptz, p_in_race text[])
returns platform.addon_vote_weeks
language plpgsql security definer set search_path = '' as $$
declare
  v_week platform.addon_vote_weeks;
  v_top integer;
  v_leaders text[];
begin
  select * into v_week from platform.addon_vote_weeks where ends_at = p_ends_at;
  if found then
    return v_week;
  end if;
  select coalesce(max(c.votes), 0) into v_top
  from platform.addon_vote_counts c
  where c.addon_id = any (p_in_race) and c.votes > 0
    and not exists (select 1 from platform.addon_picks p where p.addon_id = c.addon_id);
  select coalesce(array_agg(c.addon_id order by c.addon_id), '{}') into v_leaders
  from platform.addon_vote_counts c
  where v_top > 0 and c.addon_id = any (p_in_race) and c.votes = v_top
    and not exists (select 1 from platform.addon_picks p where p.addon_id = c.addon_id);
  if cardinality(v_leaders) = 1 then
    insert into platform.addon_vote_weeks (ends_at, outcome, addon_id, top_votes, decided_at)
    values (p_ends_at, 'votes', v_leaders[1], v_top, now())
    returning * into v_week;
    insert into platform.addon_picks (addon_id, how, week_id, votes)
    values (v_leaders[1], 'votes', v_week.id, v_top);
  elsif cardinality(v_leaders) > 1 then
    insert into platform.addon_vote_weeks (ends_at, outcome, tied, top_votes)
    values (p_ends_at, 'tie', v_leaders, v_top)
    returning * into v_week;
  else
    insert into platform.addon_vote_weeks (ends_at, outcome)
    values (p_ends_at, 'no_votes')
    returning * into v_week;
  end if;
  return v_week;
end $$;

-- ---------- the team choosing ----------
-- For a week that closed with no votes or a tie: the team's choice becomes that week's pick. The caller says it is
-- planned (the catalogue is code); this checks who is asking, the week, and the tie.
create or replace function private.choose_addon_pick(p_week uuid, p_addon text)
returns platform.addon_picks
language plpgsql security definer set search_path = '' as $$
declare
  v_week platform.addon_vote_weeks;
  v_pick platform.addon_picks;
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'Only the HandsFreeOS team chooses what comes next'
      using errcode = '42501', detail = 'addon_pick_is_ours';
  end if;
  select * into v_week from platform.addon_vote_weeks where id = p_week for update;
  if not found then
    raise exception 'There is no such week' using errcode = 'P0002', detail = 'addon_week_unknown';
  end if;
  if v_week.addon_id is not null then
    raise exception 'That week already has its pick' using errcode = '23505', detail = 'addon_week_decided';
  end if;
  if v_week.outcome = 'tie' and not (p_addon = any (v_week.tied)) then
    raise exception 'Choose one of the add-ons that tied' using errcode = '22023', detail = 'addon_not_tied';
  end if;
  if exists (select 1 from platform.addon_picks p where p.addon_id = p_addon) then
    raise exception 'That add-on is already coming soon' using errcode = '23505', detail = 'addon_already_picked';
  end if;
  insert into platform.addon_picks (addon_id, how, week_id, votes, picked_by)
  values (p_addon, 'team', v_week.id,
    coalesce((select c.votes from platform.addon_vote_counts c where c.addon_id = p_addon), 0), auth.uid())
  returning * into v_pick;
  update platform.addon_vote_weeks set addon_id = p_addon, decided_at = now(), decided_by = auth.uid()
  where id = v_week.id;
  return v_pick;
end $$;

-- ---------- who to tell ----------
-- The owners and admins of every business that voted for an add-on, not yet told this kind of news about it. One
-- row per person, however many of their businesses voted, naming one of them.
create or replace function private.addon_voters_to_tell(p_addon text, p_kind text)
returns table (user_id uuid, email text, first_name text, workspace_id uuid, business text)
language sql stable security definer set search_path = '' as $$
  select distinct on (u.id) u.id, u.email::text, split_part(btrim(u.full_name), ' ', 1), w.id, w.name
  from platform.addon_votes v
  join app.workspaces w on w.id = v.workspace_id and w.deletion_requested_at is null
  join app.workspace_memberships m on m.workspace_id = v.workspace_id and m.role in ('owner', 'admin')
  join app.users u on u.id = m.user_id and u.deleted_at is null
  where v.addon_id = p_addon
    and not exists (select 1 from platform.addon_pick_deliveries d
      where d.addon_id = p_addon and d.kind = p_kind and d.user_id = u.id)
  order by u.id, v.created_at
$$;

-- The team to ask when a week closes with nothing picked: everyone active who may choose.
create or replace function private.addon_pickers_to_tell()
returns table (user_id uuid, email text, first_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email::text, split_part(btrim(coalesce(nullif(s.display_name, ''), u.full_name)), ' ', 1)
  from platform.staff s
  join app.users u on u.id = s.user_id and u.deleted_at is null
  where s.status = 'active'
    and exists (select 1 from app.role_permissions rp
      where rp.role = 'staff_' || s.role::text and rp.permission = 'platform.addons.manage')
  order by u.id
$$;

-- ---------- row level security ----------
alter table platform.addon_votes enable row level security;
alter table platform.addon_vote_counts enable row level security;
alter table platform.addon_vote_weeks enable row level security;
alter table platform.addon_picks enable row level security;
alter table platform.addon_pick_deliveries enable row level security;
alter table platform.addon_news_seen enable row level security;

-- A business's own votes are its people's to see; who voted for what is the team's. Voting is for those who manage
-- the business's add-ons, and a vote on one already picked stays where it is: it's how its voters hear the news.
create policy addon_votes_read on platform.addon_votes for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    or (select private.staff_can('platform.addons.manage')));
create policy addon_votes_cast on platform.addon_votes for insert to authenticated
  with check (voted_by = (select auth.uid()) and private.has_permission(workspace_id, 'addons.manage')
    and not exists (select 1 from platform.addon_picks p where p.addon_id = addon_votes.addon_id));
create policy addon_votes_take_back on platform.addon_votes for delete to authenticated
  using (private.has_permission(workspace_id, 'addons.manage')
    and not exists (select 1 from platform.addon_picks p where p.addon_id = addon_votes.addon_id));
create policy addon_votes_service on platform.addon_votes for all to service_actor
  using (true) with check (true);

-- How many votes each has, and what's coming soon, are anyone's to know.
create policy addon_vote_counts_read on platform.addon_vote_counts for select to authenticated using (true);
create policy addon_vote_counts_service on platform.addon_vote_counts for all to service_actor
  using (true) with check (true);
create policy addon_picks_read on platform.addon_picks for select to authenticated using (true);
create policy addon_picks_service on platform.addon_picks for all to service_actor
  using (true) with check (true);

-- How each week closed is the team's.
create policy addon_vote_weeks_read on platform.addon_vote_weeks for select to authenticated
  using ((select private.staff_can('platform.addons.manage')));
create policy addon_vote_weeks_service on platform.addon_vote_weeks for all to service_actor
  using (true) with check (true);

create policy addon_pick_deliveries_service on platform.addon_pick_deliveries for all to service_actor
  using (true) with check (true);

create policy addon_news_seen_mine on platform.addon_news_seen for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy addon_news_seen_service on platform.addon_news_seen for all to service_actor
  using (true) with check (true);

-- ---------- grants ----------
-- Reading is by policy. Writing is by column: nobody's grant reaches a count, a pick or a week, which only the
-- trigger, the worker and private.choose_addon_pick write.
grant select on platform.addon_votes, platform.addon_vote_counts, platform.addon_vote_weeks,
  platform.addon_picks, platform.addon_news_seen to authenticated;
grant insert (addon_id, workspace_id, voted_by), delete on platform.addon_votes to authenticated;
grant insert (user_id, addon_id, kind) on platform.addon_news_seen to authenticated;
grant select, insert, update, delete on platform.addon_votes, platform.addon_vote_counts,
  platform.addon_vote_weeks, platform.addon_picks, platform.addon_pick_deliveries, platform.addon_news_seen
  to service_actor;
revoke all on platform.addon_votes, platform.addon_vote_counts, platform.addon_vote_weeks, platform.addon_picks,
  platform.addon_pick_deliveries, platform.addon_news_seen from anon;

revoke all on function
  private.count_addon_vote(), private.close_addon_vote_week(timestamptz, text[]),
  private.choose_addon_pick(uuid, text), private.addon_voters_to_tell(text, text), private.addon_pickers_to_tell()
  from public;
grant execute on function private.count_addon_vote() to authenticated, service_actor;
grant execute on function private.choose_addon_pick(uuid, text) to authenticated;
grant execute on function private.close_addon_vote_week(timestamptz, text[]), private.addon_voters_to_tell(text, text),
  private.addon_pickers_to_tell() to service_actor;
