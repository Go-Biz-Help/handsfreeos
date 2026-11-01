-- =============================================================================
-- The AI helper, what it saw on a problem report, and the ways it learned.
--
--        When a tool's step doesn't go (today the browser extension's, on any network), an **AI helper** looks at
--        the page's view (its shape, with everything a person wrote hidden) and sorts it: something in the way,
--        which it clears; a layout difference, where it finds the step's button in its new place; the network
--        refusing; or a warning. What it did goes on the step's problem report (`helper`), so the support desk's
--        Problem reports page shows it beside the outline, and the desk counts the reports by step.
--
--        A **learned way** is how the helper found a step's button in a new place (its tag, role, the network's
--        own words on it with a person's as "[2 words]", and what it sits inside), kept across every business so
--        the next computer finds it without the AI. It's trusted once it has worked twice with the page showing
--        the step went. Staff see each one on the desk and can set one aside. Never anything a person wrote.
--
--        A handed-over step (Social Outreach's needs) keeps the report it was sent with (`report_id`), so staff
--        open it from the person's Needs you. A label, not a key: reports go after 30 days.
--
-- Only adds: two columns, two tables, their definers, and the desk's definers again with the helper's columns.
-- =============================================================================

-- ---------- what the helper did, on a report ----------
alter table app.problem_reports add column helper jsonb
  check (helper is null or (jsonb_typeof(helper) = 'object' and pg_column_size(helper) <= 16384));

-- The desk's list, as before, with the helper's verdict and how it ended. New columns go last: `select *` readers
-- from before keep working.
drop function private.admin_problem_reports(boolean, text, timestamptz, int);
create function private.admin_problem_reports(p_open boolean, p_area text, p_before timestamptz, p_limit int)
returns table (id uuid, created_at timestamptz, workspace_id uuid, business text, addon_id text, source text,
  area text, job text, ref text, version text, page text, path text, shown boolean, note text, has_outline boolean,
  handled_at timestamptz, helper_verdict text, helper_result text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.created_at, r.workspace_id, w.name, r.addon_id, r.source, r.area, r.job, r.ref, r.version, r.page,
    r.path, r.shown, r.note, r.outline is not null, r.handled_at, r.helper ->> 'verdict', r.helper ->> 'result'
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
  where private.staff_can('platform.health.read')
    and (p_open is null or (r.handled_at is null) = p_open)
    and (p_area is null or r.area = p_area)
    and (p_before is null or r.created_at < p_before)
  order by r.created_at desc, r.id
  limit greatest(1, least(coalesce(p_limit, 25), 100))
$$;

-- One report, outline and all, and what the helper did.
drop function private.admin_problem_report(uuid);
create function private.admin_problem_report(p_id uuid)
returns table (id uuid, created_at timestamptz, workspace_id uuid, business text, addon_id text, source text,
  area text, job text, ref text, version text, page text, path text, shown boolean, found jsonb, note text,
  outline text, handled_at timestamptz, handled_by_name text, helper jsonb)
language sql stable security definer set search_path = '' as $$
  select r.id, r.created_at, r.workspace_id, w.name, r.addon_id, r.source, r.area, r.job, r.ref, r.version, r.page,
    r.path, r.shown, r.found, r.note, r.outline, r.handled_at, nullif(u.full_name, ''), r.helper
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
    left join app.users u on u.id = r.handled_by
  where private.staff_can('platform.health.read') and r.id = p_id
$$;

-- The reports since a moment, counted by where and what they were doing: how many there were, how many are still
-- open, and how the helper sorted them.
create function private.admin_problem_report_steps(p_since timestamptz)
returns table (area text, job text, reports integer, open integer, in_the_way integer, moved integer,
  refused integer, fixed integer, done_by_helper integer)
language sql stable security definer set search_path = '' as $$
  select r.area, r.job, count(*)::int,
    count(*) filter (where r.handled_at is null)::int,
    count(*) filter (where r.helper ->> 'verdict' = 'in_the_way')::int,
    count(*) filter (where r.helper ->> 'verdict' = 'moved')::int,
    count(*) filter (where r.helper ->> 'verdict' = 'refused')::int,
    count(*) filter (where r.helper ->> 'result' = 'fixed_itself')::int,
    count(*) filter (where r.helper ->> 'result' = 'done_by_helper')::int
  from app.problem_reports r
  where private.staff_can('platform.health.read') and r.created_at >= p_since
  group by r.area, r.job
  order by count(*) desc, r.area, r.job
  limit 100
$$;

-- ---------- the report a handed-over step was sent with ----------
alter table addon_outreach.needs add column report_id uuid;

-- ---------- learned ways ----------
create table platform.learned_ways (
  id uuid primary key default gen_random_uuid(),
  -- The add-on whose tool learned it; null for core's own. A label, never a key into the add-on.
  addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  -- The network or part of the app, as problem reports name it.
  area text not null check (area ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- The step's own button it presses ("add_friend", "connect"…).
  button text not null check (button ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- How it's found: tag, role, the network's own words on it (a person's as "[…]"), what it sits inside, and the
  -- menu it's under. Never what a person wrote.
  way jsonb not null check (jsonb_typeof(way) = 'object' and pg_column_size(way) <= 4096),
  -- The same way as one line, so the same find from two computers is one row.
  way_key text not null check (char_length(way_key) between 1 and 1000),
  worked integer not null default 0 check (worked >= 0),
  failed integer not null default 0 check (failed >= 0),
  -- Once it has worked twice, every computer tries it before asking the AI.
  trusted_at timestamptz,
  -- Set aside by staff: never tried again, and never learned again.
  removed_at timestamptz,
  removed_by uuid references app.users (id) on delete set null,
  first_at timestamptz not null default now(),
  last_worked_at timestamptz,
  last_failed_at timestamptz,
  check (removed_by is null or removed_at is not null),
  unique nulls not distinct (addon_id, area, button, way_key)
);
create index learned_ways_trusted_idx on platform.learned_ways (area, button)
  where trusted_at is not null and removed_at is null;
create index learned_ways_removed_by_idx on platform.learned_ways (removed_by) where removed_by is not null;

-- Which businesses each worked or failed for: how widely it holds. Goes with the business.
create table platform.learned_way_uses (
  way_id uuid not null references platform.learned_ways (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  worked integer not null default 0 check (worked >= 0),
  failed integer not null default 0 check (failed >= 0),
  last_at timestamptz not null default now(),
  primary key (way_id, workspace_id)
);
create index learned_way_uses_workspace_idx on platform.learned_way_uses (workspace_id);

-- The worker reads the trusted ones for a computer; staff read them through the definers below. Nobody writes but
-- through the definers.
alter table platform.learned_ways enable row level security;
alter table platform.learned_way_uses enable row level security;
create policy learned_ways_service_select on platform.learned_ways for select to service_actor using (true);
create policy learned_way_uses_service_select on platform.learned_way_uses for select to service_actor using (true);
grant select on platform.learned_ways, platform.learned_way_uses to service_actor;
revoke all on platform.learned_ways, platform.learned_way_uses from anon, authenticated;

-- A way pressed in a business, and whether the page showed the step went: counted, and trusted once it has worked
-- twice. One set aside stays aside. The worker calls it for a person's computer, in that business.
create function private.note_learned_way(p_workspace uuid, p_addon text, p_area text, p_button text, p_way jsonb,
  p_way_key text, p_worked boolean)
returns table (id uuid, trusted boolean, removed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into platform.learned_ways as w (addon_id, area, button, way, way_key)
  values (p_addon, p_area, p_button, p_way, p_way_key)
  on conflict (addon_id, area, button, way_key) do update set way = w.way
  returning w.id into v_id;
  update platform.learned_ways w
  set worked = w.worked + case when p_worked then 1 else 0 end,
      failed = w.failed + case when p_worked then 0 else 1 end,
      last_worked_at = case when p_worked then now() else w.last_worked_at end,
      last_failed_at = case when p_worked then w.last_failed_at else now() end,
      trusted_at = case
        when w.trusted_at is null and w.removed_at is null and p_worked and w.worked + 1 >= 2 then now()
        else w.trusted_at end
  where w.id = v_id and w.removed_at is null;
  insert into platform.learned_way_uses as u (way_id, workspace_id, worked, failed)
  values (v_id, p_workspace, case when p_worked then 1 else 0 end, case when p_worked then 0 else 1 end)
  on conflict (way_id, workspace_id) do update
    set worked = u.worked + excluded.worked, failed = u.failed + excluded.failed, last_at = now();
  return query
    select w.id, w.trusted_at is not null and w.removed_at is null, w.removed_at is not null
    from platform.learned_ways w where w.id = v_id;
end $$;

-- The desk's list: every way on one area or all, the trusted first, with how many businesses it worked for.
create function private.admin_learned_ways(p_area text)
returns table (id uuid, addon_id text, area text, button text, way jsonb, worked integer, failed integer,
  businesses integer, trusted_at timestamptz, removed_at timestamptz, first_at timestamptz,
  last_worked_at timestamptz, last_failed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select w.id, w.addon_id, w.area, w.button, w.way, w.worked, w.failed,
    (select count(*) from platform.learned_way_uses u where u.way_id = w.id and u.worked > 0)::int,
    w.trusted_at, w.removed_at, w.first_at, w.last_worked_at, w.last_failed_at
  from platform.learned_ways w
  where private.staff_can('platform.health.read') and (p_area is null or w.area = p_area)
  order by (w.removed_at is null) desc, (w.trusted_at is not null) desc, w.last_worked_at desc nulls last, w.id
  limit 200
$$;

-- Sets ways aside, or brings them back; returns the ones it changed. Staff-only: it checks for itself.
create function private.set_learned_ways_removed(p_ids uuid[], p_removed boolean)
returns table (id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.staff_can('platform.health.read') then
    raise exception 'Only HandsFreeOS staff set learned ways aside'
      using errcode = '42501', detail = 'learned_ways_are_ours';
  end if;
  if coalesce(cardinality(p_ids), 0) > 100 then
    raise exception 'At most 100 at a time' using errcode = '22023', detail = 'too_many_learned_ways';
  end if;
  return query
    update platform.learned_ways w
    set removed_at = case when p_removed then now() end,
        removed_by = case when p_removed then (select auth.uid()) end,
        -- Brought back, it's trusted again only as it earned it.
        trusted_at = case when p_removed then w.trusted_at when w.worked >= 2 then coalesce(w.trusted_at, now()) end
    where w.id = any (p_ids) and (w.removed_at is null) = p_removed
    returning w.id;
end $$;

-- Ways that haven't worked in 90 days go, set aside or not, a batch at a time: pages change, and an old way is
-- only a wrong guess waiting. The worker's night clean-up calls it with the reports'.
create function private.delete_stale_learned_ways(p_limit integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from platform.learned_ways w
  where w.id in (
    select x.id from platform.learned_ways x
    where coalesce(x.last_worked_at, x.first_at) < now() - interval '90 days'
    order by coalesce(x.last_worked_at, x.first_at)
    limit greatest(1, least(coalesce(p_limit, 1000), 10000)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function
  private.admin_problem_reports(boolean, text, timestamptz, int), private.admin_problem_report(uuid),
  private.admin_problem_report_steps(timestamptz),
  private.note_learned_way(uuid, text, text, text, jsonb, text, boolean), private.admin_learned_ways(text),
  private.set_learned_ways_removed(uuid[], boolean), private.delete_stale_learned_ways(integer)
  from public;
grant execute on function
  private.admin_problem_reports(boolean, text, timestamptz, int), private.admin_problem_report(uuid),
  private.admin_problem_report_steps(timestamptz), private.admin_learned_ways(text),
  private.set_learned_ways_removed(uuid[], boolean)
  to authenticated;
grant execute on function
  private.note_learned_way(uuid, text, text, text, jsonb, text, boolean), private.delete_stale_learned_ways(integer)
  to service_actor;
