-- =============================================================================
-- Problem reports: limits apart from what needs a fix, and reports that clear themselves.
--
--        Each report is sorted when it's sent (core's `problemKind`, support/problem-sort.ts):
--        - a **limit**: the business's daily AI limit, its balance running out, or a network refusing or warning
--          (a connection limit, say). Nothing in HandsFreeOS to fix: it waits out, or the business raises it.
--        - a **fix**: everything else, something in HandsFreeOS to look at.
--        The support desk's Problem reports page shows the limits apart, on top, and what needs a fix grouped by
--        problem: its area, its step and what went wrong.
--
--        Reports clear themselves: they move to Handled with why (`cleared`), and nobody's name on them.
--        - limit_over: a limit once it's over (the daily AI limit at the business's own midnight, the rest after a
--          day);
--        - fixed: every report of a problem from a version before the one with its fix (core's PROBLEM_FIXES, which
--          a fix adds to), once that fix is live;
--        - quiet: every report of a problem that hasn't happened again for 3 days.
--        The worker's `problem_reports.clear` does it every hour.
--
-- Only adds: four columns, an index, the sorting of the reports so far, and new definers beside the old ones, which
-- the running API still calls (a later migration drops private.admin_problem_reports and
-- private.admin_problem_report). private.set_problem_reports_handled is replaced in place, with the same arguments,
-- so opening a cleared report again clears why too.
-- =============================================================================

alter table app.problem_reports
  add column kind text not null default 'fix' check (kind in ('fix', 'limit')),
  add column limit_kind text check (limit_kind is null or limit_kind in ('ai_daily', 'ai_balance', 'network')),
  add column cleared text check (cleared is null or cleared in ('limit_over', 'fixed', 'quiet')),
  add column fixed_in text check (fixed_in is null or char_length(fixed_in) <= 20),
  add constraint problem_reports_limit_kind check ((kind = 'limit') = (limit_kind is not null)),
  add constraint problem_reports_cleared check (cleared is null or (handled_at is not null and handled_by is null)),
  add constraint problem_reports_fixed_in check (fixed_in is null or cleared = 'fixed');

-- A problem's reports (its area, step and words), newest first: the desk's groups and the quiet check.
create index problem_reports_problem_idx on app.problem_reports (area, job, created_at desc);

-- ---------- the reports so far, sorted ----------
-- As core's problemKind sorts a new one: the daily AI limit's words and the balance's, then a network refusing or
-- warning, or saying it's a limit.
update app.problem_reports r
set kind = 'limit',
    limit_kind = case
      when r.note ~ '^This business reached (the \$[0-9.,]+ daily AI limit|today’s AI limit)' then 'ai_daily'
      when r.note like 'Your balance has run out, so the AI has paused%' then 'ai_balance'
      else 'network' end
where r.note ~ '^This business reached (the \$[0-9.,]+ daily AI limit|today’s AI limit)'
  or r.note like 'Your balance has run out, so the AI has paused%'
  or r.helper ->> 'verdict' in ('refused', 'warning')
  or r.note ~* '\m(daily|weekly|monthly) (connection |invitation |invite |request )?limit\M';

-- ---------- versions ----------
-- A tool's version as numbers to sort by ("0.126.0" → {0,126,0}); null when it isn't one.
create function private.version_parts(p_version text)
returns int[] language sql immutable set search_path = '' as $$
  select case when p_version ~ '^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$' then string_to_array(p_version, '.')::int[] end
$$;

-- ---------- the desk ----------
-- The reports, newest first, a page at a time, as private.admin_problem_reports, on one step too and one kind, with
-- each one's kind and why it cleared.
create function private.admin_problem_report_page(p_open boolean, p_area text, p_job text, p_kind text,
  p_before timestamptz, p_limit int)
returns table (id uuid, created_at timestamptz, workspace_id uuid, business text, addon_id text, source text,
  area text, job text, ref text, version text, page text, path text, shown boolean, note text, has_outline boolean,
  handled_at timestamptz, helper_verdict text, helper_result text, kind text, limit_kind text, cleared text,
  fixed_in text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.created_at, r.workspace_id, w.name, r.addon_id, r.source, r.area, r.job, r.ref, r.version, r.page,
    r.path, r.shown, r.note, r.outline is not null, r.handled_at, r.helper ->> 'verdict', r.helper ->> 'result',
    r.kind, r.limit_kind, r.cleared, r.fixed_in
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
  where private.staff_can('platform.health.read')
    and (p_open is null or (r.handled_at is null) = p_open)
    and (p_area is null or r.area = p_area)
    and (p_job is null or r.job = p_job)
    and (p_kind is null or r.kind = p_kind)
    and (p_before is null or r.created_at < p_before)
  order by r.created_at desc, r.id
  limit greatest(1, least(coalesce(p_limit, 25), 100))
$$;

-- One report, outline and all, as private.admin_problem_report, with its kind and why it cleared.
create function private.admin_problem_report_full(p_id uuid)
returns table (id uuid, created_at timestamptz, workspace_id uuid, business text, addon_id text, source text,
  area text, job text, ref text, version text, page text, path text, shown boolean, found jsonb, note text,
  outline text, handled_at timestamptz, handled_by_name text, helper jsonb, kind text, limit_kind text,
  cleared text, fixed_in text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.created_at, r.workspace_id, w.name, r.addon_id, r.source, r.area, r.job, r.ref, r.version, r.page,
    r.path, r.shown, r.found, r.note, r.outline, r.handled_at, nullif(u.full_name, ''), r.helper, r.kind,
    r.limit_kind, r.cleared, r.fixed_in
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
    left join app.users u on u.id = r.handled_by
  where private.staff_can('platform.health.read') and r.id = p_id
$$;

-- The open reports grouped, on one area or all. A fix is grouped by problem across every business: its area, step
-- and words. A limit is grouped by business and limit (and network, for a network's): one line each on the desk.
create function private.admin_problem_groups(p_area text)
returns table (kind text, limit_kind text, workspace_id uuid, business text, area text, areas text[], job text,
  note text, reports integer, businesses integer, first_at timestamptz, last_at timestamptz, newest_version text,
  report_id uuid, in_the_way integer, moved integer, not_looked integer)
language sql stable security definer set search_path = '' as $$
  (select 'fix'::text, null::text, null::uuid,
    case when count(distinct r.workspace_id) = 1 then max(w.name) end,
    r.area, array[r.area], r.job, r.note, count(*)::int, count(distinct r.workspace_id)::int,
    min(r.created_at), max(r.created_at),
    (array_agg(r.version order by private.version_parts(r.version) desc nulls last))[1],
    (array_agg(r.id order by r.created_at desc))[1],
    count(*) filter (where r.helper ->> 'verdict' = 'in_the_way')::int,
    count(*) filter (where r.helper ->> 'verdict' = 'moved')::int,
    count(*) filter (where r.helper ->> 'notLooked' is not null)::int
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
  where private.staff_can('platform.health.read') and r.handled_at is null and r.kind = 'fix'
    and (p_area is null or r.area = p_area)
  group by r.area, r.job, r.note
  order by max(r.created_at) desc
  limit 200)
  union all
  (select 'limit'::text, r.limit_kind, r.workspace_id, max(w.name),
    case when r.limit_kind = 'network' then r.area end,
    array_agg(distinct r.area order by r.area),
    case when count(distinct r.job) = 1 then max(r.job) end,
    (array_agg(r.note order by r.created_at desc))[1],
    count(*)::int, 1, min(r.created_at), max(r.created_at),
    (array_agg(r.version order by private.version_parts(r.version) desc nulls last))[1],
    (array_agg(r.id order by r.created_at desc))[1],
    0, 0, 0
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
  where private.staff_can('platform.health.read') and r.handled_at is null and r.kind = 'limit'
    and (p_area is null or r.area = p_area)
  group by r.workspace_id, r.limit_kind, case when r.limit_kind = 'network' then r.area end
  order by max(r.created_at) desc
  limit 100)
$$;

-- Marks reports handled, or open again; returns the ones it changed. Staff-only: it checks for itself. As before,
-- and opening one that cleared itself forgets why.
create or replace function private.set_problem_reports_handled(p_ids uuid[], p_handled boolean)
returns table (id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.staff_can('platform.health.read') then
    raise exception 'Only HandsFreeOS staff mark problem reports handled'
      using errcode = '42501', detail = 'problem_reports_are_ours';
  end if;
  if coalesce(cardinality(p_ids), 0) > 100 then
    raise exception 'At most 100 at a time' using errcode = '22023', detail = 'too_many_problem_reports';
  end if;
  return query
    update app.problem_reports r
    set handled_at = case when p_handled then now() end,
        handled_by = case when p_handled then (select auth.uid()) end,
        cleared = null,
        fixed_in = null
    where r.id = any (p_ids) and (r.handled_at is null) = p_handled
    returning r.id;
end $$;

-- ---------- clearing on their own ----------
-- Limits that are over, and problems that haven't happened again for p_quiet_days, at most p_limit of each a go:
-- moved to Handled with why. Across every business, so a definer only the worker may call.
create function private.clear_problem_reports(p_quiet_days integer, p_limit integer)
returns table (limit_over integer, quiet integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_over integer;
  v_quiet integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 10000));
  v_days integer := greatest(1, coalesce(p_quiet_days, 3));
begin
  -- The daily AI limit is over at the business's own midnight after the report, as private.ai_spend_today counts
  -- the day; any other limit after a day.
  update app.problem_reports r
  set handled_at = now(), cleared = 'limit_over'
  where r.id in (
    select x.id from app.problem_reports x join app.workspaces w on w.id = x.workspace_id
    where x.handled_at is null and x.kind = 'limit'
      and case
        when x.limit_kind = 'ai_daily' then
          date_trunc('day', x.created_at at time zone coalesce(w.timezone, 'UTC'))
            < date_trunc('day', now() at time zone coalesce(w.timezone, 'UTC'))
        else x.created_at < now() - interval '1 day' end
    order by x.created_at
    limit v_limit);
  get diagnostics v_over = row_count;

  update app.problem_reports r
  set handled_at = now(), cleared = 'quiet'
  where r.id in (
    select x.id from app.problem_reports x
    where x.handled_at is null and x.kind = 'fix'
      and x.created_at < now() - make_interval(days => v_days)
      and not exists (
        select 1 from app.problem_reports y
        where y.area = x.area and y.job = x.job and y.note is not distinct from x.note
          and y.created_at >= now() - make_interval(days => v_days))
    order by x.created_at
    limit v_limit);
  get diagnostics v_quiet = row_count;

  return query select v_over, v_quiet;
end $$;

-- Every open report of one fixed problem (a fix, not a limit): from its tool (source), area and step, its words when
-- they start with p_note (every one of the step's when null), and from a version before p_fixed_in, or sent before
-- p_before for a tool without versions. Moved to Handled as fixed, with the version. Only the worker calls it.
create function private.clear_fixed_problem_reports(p_source text, p_area text, p_job text, p_note text,
  p_fixed_in text, p_before timestamptz, p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if p_fixed_in is null and p_before is null then
    raise exception 'A fix needs the version it went out in, or when'
      using errcode = '22023', detail = 'problem_fix_needs_when';
  end if;
  update app.problem_reports r
  set handled_at = now(), cleared = 'fixed', fixed_in = left(p_fixed_in, 20)
  where r.id in (
    select x.id from app.problem_reports x
    where x.handled_at is null and x.kind = 'fix' and x.source = p_source and x.area = p_area and x.job = p_job
      and (p_note is null or left(coalesce(x.note, ''), char_length(p_note)) = p_note)
      and (p_fixed_in is null
        or private.version_parts(x.version) < private.version_parts(p_fixed_in))
      and (p_before is null or x.created_at < p_before)
    order by x.created_at
    limit greatest(1, least(coalesce(p_limit, 1000), 10000)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function
  private.version_parts(text),
  private.admin_problem_report_page(boolean, text, text, text, timestamptz, int),
  private.admin_problem_report_full(uuid),
  private.admin_problem_groups(text),
  private.clear_problem_reports(integer, integer),
  private.clear_fixed_problem_reports(text, text, text, text, text, timestamptz, integer)
  from public;
grant execute on function
  private.version_parts(text),
  private.admin_problem_report_page(boolean, text, text, text, timestamptz, int),
  private.admin_problem_report_full(uuid),
  private.admin_problem_groups(text)
  to authenticated;
grant execute on function
  private.version_parts(text),
  private.clear_problem_reports(integer, integer),
  private.clear_fixed_problem_reports(text, text, text, text, text, timestamptz, integer)
  to service_actor;
