-- =============================================================================
-- Problem reports: what HandsFreeOS's own tools saw when something didn't go.
--
--        A **problem report** is a note sent by one of our tools on a
--        person's behalf when it couldn't do something: today the browser
--        extension, for any network it works on. It says what the tool was
--        doing and where, which version it was, whether Chrome showed the
--        page, what its readers found (counts, yes or no and the network's
--        own section names, never words), a line in its own words on what was
--        missing and, when asked, the page's outline (tags, roles and the
--        network's own words; everything a person wrote is "[2 words]").
--
--        HandsFreeOS's staff read them across every business on the support
--        desk's Problem reports page (platform.health.read), through the
--        definers below, and mark each handled. The person who sent one reads
--        their own. They go after 30 days, handled or not (the worker's
--        `problem_reports.clean_up`).
--
--        Any add-on's tool may send one: `addon_id` is a label, never a key
--        into the add-on (docs/addon-architecture.md, "Core never points into
--        an add-on"). Social Outreach's own notes (addon_outreach.reports,
--        0.48.0) are copied here; that table is dropped in a later migration.
--
-- Only adds: a table, its definers, and a copy of the add-on's notes.
-- =============================================================================

create table app.problem_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The person whose tool sent it.
  user_id uuid not null references app.users (id) on delete cascade,
  -- The add-on the tool belongs to; null for core's own.
  addon_id text check (addon_id is null or addon_id ~ '^[a-z]{2,16}$'),
  source text not null check (source in ('extension', 'web', 'phone')),
  -- Where: the network ("linkedin", "facebook"…) or the part of the app.
  area text not null check (area ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- What it was doing: an ask's kind, or a day's step ("like", "comment"…).
  job text not null check (char_length(job) between 1 and 40),
  -- The tool's own id for that, when it has one (an ask's): text, never a key.
  ref text check (ref is null or char_length(ref) <= 100),
  version text check (version is null or char_length(version) <= 20),
  -- The page's kind as the tool names it ("own-profile", "feed"…), and its address with people's parts as {1}, {2}…
  page text not null check (char_length(page) between 1 and 40),
  path text not null default '' check (char_length(path) <= 500),
  -- Whether Chrome showed the page: it draws nothing in a window hidden behind another.
  shown boolean,
  found jsonb not null default '{}'::jsonb
    check (jsonb_typeof(found) = 'object' and pg_column_size(found) <= 8192),
  note text check (note is null or char_length(note) <= 300),
  outline text check (outline is null or char_length(outline) <= 200000),
  handled_at timestamptz,
  handled_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (handled_by is null or handled_at is not null)
);
-- The desk's list: the open ones, newest first; and the night's clean-up, oldest first.
create index problem_reports_open_idx on app.problem_reports (created_at desc) where handled_at is null;
create index problem_reports_created_idx on app.problem_reports (created_at);
create index problem_reports_workspace_idx on app.problem_reports (workspace_id);
create index problem_reports_user_idx on app.problem_reports (user_id, created_at desc);
create index problem_reports_handled_by_idx on app.problem_reports (handled_by) where handled_by is not null;

create or replace function private.check_problem_report_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger problem_reports_check_refs before insert on app.problem_reports
  for each row execute function private.check_problem_report_refs();

-- ---------- RLS: a person sends and reads their own; staff go through the definers ----------
alter table app.problem_reports enable row level security;

create policy problem_reports_select on app.problem_reports for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid()));
create policy problem_reports_insert on app.problem_reports for insert to authenticated
  with check (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid())
    and handled_at is null and handled_by is null);

grant select, insert on app.problem_reports to authenticated;
revoke all on app.problem_reports from anon;

-- ---------- the desk ----------
-- The reports, newest first, a page at a time (before the last one's time): open, handled or both (null), on one
-- area or all. Never the outline here: it's read one report at a time.
create or replace function private.admin_problem_reports(p_open boolean, p_area text, p_before timestamptz, p_limit int)
returns table (id uuid, created_at timestamptz, workspace_id uuid, business text, addon_id text, source text,
  area text, job text, ref text, version text, page text, path text, shown boolean, note text, has_outline boolean,
  handled_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.created_at, r.workspace_id, w.name, r.addon_id, r.source, r.area, r.job, r.ref, r.version, r.page,
    r.path, r.shown, r.note, r.outline is not null, r.handled_at
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
  where private.staff_can('platform.health.read')
    and (p_open is null or (r.handled_at is null) = p_open)
    and (p_area is null or r.area = p_area)
    and (p_before is null or r.created_at < p_before)
  order by r.created_at desc, r.id
  limit greatest(1, least(coalesce(p_limit, 25), 100))
$$;

-- How many are open, on each area: the desk's filter says so.
create or replace function private.admin_problem_report_areas()
returns table (area text, open integer)
language sql stable security definer set search_path = '' as $$
  select r.area, count(*) filter (where r.handled_at is null)::int
  from app.problem_reports r
  where private.staff_can('platform.health.read')
  group by r.area
  order by r.area
$$;

-- One report, outline and all.
create or replace function private.admin_problem_report(p_id uuid)
returns table (id uuid, created_at timestamptz, workspace_id uuid, business text, addon_id text, source text,
  area text, job text, ref text, version text, page text, path text, shown boolean, found jsonb, note text,
  outline text, handled_at timestamptz, handled_by_name text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.created_at, r.workspace_id, w.name, r.addon_id, r.source, r.area, r.job, r.ref, r.version, r.page,
    r.path, r.shown, r.found, r.note, r.outline, r.handled_at, nullif(u.full_name, '')
  from app.problem_reports r join app.workspaces w on w.id = r.workspace_id
    left join app.users u on u.id = r.handled_by
  where private.staff_can('platform.health.read') and r.id = p_id
$$;

-- Marks reports handled, or open again; returns the ones it changed. Staff-only: it checks for itself.
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
        handled_by = case when p_handled then (select auth.uid()) end
    where r.id = any (p_ids) and (r.handled_at is null) = p_handled
    returning r.id;
end $$;

-- ---------- the night's clean-up ----------
-- Reports older than 30 days go, handled or not, a batch at a time (the worker calls it until it returns fewer than
-- it asked for). Across every business, so a definer only the worker may call; the age is fixed here.
create or replace function private.delete_old_problem_reports(p_limit integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from app.problem_reports r
  where r.id in (
    select x.id from app.problem_reports x
    where x.created_at < now() - interval '30 days'
    order by x.created_at
    limit greatest(1, least(coalesce(p_limit, 1000), 10000)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function
  private.check_problem_report_refs(),
  private.admin_problem_reports(boolean, text, timestamptz, int), private.admin_problem_report_areas(),
  private.admin_problem_report(uuid), private.set_problem_reports_handled(uuid[], boolean),
  private.delete_old_problem_reports(integer)
  from public;
grant execute on function private.check_problem_report_refs() to authenticated;
grant execute on function
  private.admin_problem_reports(boolean, text, timestamptz, int), private.admin_problem_report_areas(),
  private.admin_problem_report(uuid), private.set_problem_reports_handled(uuid[], boolean)
  to authenticated;
grant execute on function private.delete_old_problem_reports(integer) to service_actor;

-- ---------- Social Outreach's notes so far ----------
insert into app.problem_reports (id, workspace_id, user_id, addon_id, source, area, job, ref, version, page, path,
  shown, found, note, outline, created_at)
select r.id, r.workspace_id, r.user_id, 'outreach', 'extension', r.platform, r.job, r.ask_id::text, r.version,
  r.page, r.path, r.shown, r.found, r.note, r.outline, r.created_at
from addon_outreach.reports r
where coalesce(private.workspace_has_user(r.workspace_id, r.user_id), false)
on conflict (id) do nothing;
