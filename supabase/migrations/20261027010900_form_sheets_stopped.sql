-- =============================================================================
-- Stopped partway (funnels): somebody we know who started a form and went quiet.
--
--        The page says which page they're on as it saves. Thirty minutes
--        with nothing from it, on a sheet that knows who it's for, and the
--        worker's sweep marks that page stopped once: form.stopped goes out,
--        which a workflow can start on ("Somebody stops partway through a
--        form") and text them "you were halfway through the overview". If
--        they come back and stop again further on, that page fires too.
--
--        Sheets quieter than a week are left alone: the sweep is for
--        somebody who just walked away, not a sheet from last month.
-- =============================================================================

alter table app.form_responses
  add column last_active_at timestamptz,
  add column at_page_id text check (at_page_id is null or at_page_id ~ '^p_[a-z0-9]{8}$'),
  add column stopped_pages text[] not null default '{}';

create index form_responses_stopped_idx on app.form_responses (last_active_at)
  where status = 'in_progress' and person_id is not null and at_page_id is not null;

-- People read where a sheet got to; only the worker writes it.
grant select (last_active_at, at_page_id, stopped_pages) on app.form_responses to authenticated;

-- ---------- the worker's sweep ----------
-- Across every business, so it holds no business while it looks; each sheet is then marked in its own.
create or replace function private.form_sheets_stopped(p_idle_minutes integer, p_limit integer)
returns table (response_id uuid, workspace_id uuid, organization_id uuid, page_id text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.workspace_id, w.organization_id, r.at_page_id
  from app.form_responses r
  join app.workspaces w on w.id = r.workspace_id
  where r.status = 'in_progress'
    and r.person_id is not null
    and r.at_page_id is not null
    and r.bin_item_id is null
    and w.deletion_requested_at is null
    and r.last_active_at < now() - make_interval(mins => p_idle_minutes)
    and r.last_active_at > now() - interval '7 days'
    and not (r.at_page_id = any (r.stopped_pages))
  order by r.last_active_at
  limit p_limit
$$;

revoke all on function private.form_sheets_stopped(integer, integer) from public;
grant execute on function private.form_sheets_stopped(integer, integer) to service_actor;
