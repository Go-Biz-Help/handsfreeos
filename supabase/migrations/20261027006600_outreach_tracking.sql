-- =============================================================================
-- Social Outreach (outreach): tracking, the daily numbers
-- (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, "Tracking: the daily
-- numbers"; docs/outreach.md, decision 70).
--
--        The three numbers the video says to watch each day: first
--        messages sent, positive replies and calls booked.
--
--        `private.outreach_numbers` counts them in a stretch, by the
--        playbook each first message's opener came from (`opener_uses`) and
--        the main offer's version each person was first pitched with
--        (`follow_ups`). Counts only, never who: owners and admins count
--        anyone's, a person only their own, and the worker the business it
--        works for (private.outreach_may_count). `stages` and `follow_ups`
--        are each person's own, so the team's numbers come through it, and
--        so do the main offer page's numbers by version
--        (`outreach.offer.versions`), which counted only the asker's own.
--
--        `automation.day_report` is each person's day's report: a push at
--        the end of their working hours with the day's numbers, on to start
--        and off in My settings.
--
--        `reviews` keeps each person's week's review: what to fix first,
--        in the video's order, the week's numbers, and the words the AI
--        wrote from them (or the numbers' own, when it couldn't). One a
--        person a week, each person's own.
--
-- Only adds: a column, a table and a function.
-- =============================================================================

alter table addon_outreach.automation
  add column day_report boolean not null default true;

create table addon_outreach.reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  week date not null check (extract(isodow from week) = 1),
  fix text not null check (fix in ('volume', 'message', 'video', 'on_track')),
  numbers jsonb not null
    check (jsonb_typeof(numbers) = 'object' and octet_length(numbers::text) <= 500),
  target integer check (target is null or target >= 0),
  headline text not null check (length(btrim(headline)) between 1 and 80),
  why text not null check (length(btrim(why)) between 1 and 300),
  steps jsonb not null
    check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 3
      and octet_length(steps::text) <= 1000),
  by text not null check (by in ('ai', 'rules')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, week)
);
create index reviews_user_idx on addon_outreach.reviews (workspace_id, user_id, week desc);
select private.addon_table_policies('addon_outreach.reviews', 'outreach.use', 'outreach.use', null, null);
create policy reviews_own on addon_outreach.reviews as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The three numbers in [p_from, p_to): people first messaged (a chat
-- started, as the extension noted it, or first pitched in a conversation,
-- whichever came first), people who first said yes, and people who booked a
-- call (not taken back), each by the playbook its first message came from
-- and the offer's version they were first pitched with. One person's
-- (p_user), or everyone's (p_everyone): only owners and admins, or the
-- worker, count everyone's.
create or replace function private.outreach_numbers(
  p_ws uuid, p_user uuid, p_everyone boolean, p_from timestamptz, p_to timestamptz)
returns table (playbook_id uuid, offer_version integer, messages int, positive int, booked int)
language sql stable security definer set search_path = '' as $$
  with firsts as (
    select t.user_id, t.profile_id, t.at
    from addon_outreach.touches t
    where t.workspace_id = p_ws and (p_everyone or t.user_id = p_user) and t.step = 'first_message'
    union all
    select f.user_id, f.profile_id, f.created_at
    from addon_outreach.follow_ups f
    where f.workspace_id = p_ws and (p_everyone or f.user_id = p_user)
  ),
  counted as (
    select 'message' as what, x.user_id, x.profile_id
    from firsts x
    group by x.user_id, x.profile_id
    having min(x.at) >= p_from and min(x.at) < p_to
    union all
    select 'positive', s.user_id, s.profile_id
    from addon_outreach.stages s
    where s.workspace_id = p_ws and (p_everyone or s.user_id = p_user)
      and s.positive_at >= p_from and s.positive_at < p_to
    union all
    select distinct 'booked', d.user_id, d.profile_id
    from addon_outreach.demos d
    where d.workspace_id = p_ws and (p_everyone or d.user_id = p_user)
      and d.undone_at is null and d.at >= p_from and d.at < p_to
  )
  select o.playbook_id, f.offer_version,
    (count(*) filter (where c.what = 'message'))::int,
    (count(*) filter (where c.what = 'positive'))::int,
    (count(*) filter (where c.what = 'booked'))::int
  from counted c
  left join addon_outreach.opener_uses o
    on o.workspace_id = p_ws and o.user_id = c.user_id and o.profile_id = c.profile_id
  left join addon_outreach.follow_ups f
    on f.workspace_id = p_ws and f.user_id = c.user_id and f.profile_id = c.profile_id
  where case when p_everyone
    then (current_setting('role', true) = 'service_actor' and p_ws = private.system_scope_workspace())
      or private.has_permission(p_ws, 'outreach.manage')
    else private.outreach_may_count(p_ws, array[p_user]) end
  group by o.playbook_id, f.offer_version
$$;
revoke all on function private.outreach_numbers(uuid, uuid, boolean, timestamptz, timestamptz) from public;
grant execute on function private.outreach_numbers(uuid, uuid, boolean, timestamptz, timestamptz)
  to authenticated, service_actor;
