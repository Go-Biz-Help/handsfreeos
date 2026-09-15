-- =============================================================================
-- 0042 · Every business's time zone, for the Action Center's global planning
--        job (attention.plan). It runs hourly with an empty scope, which sees
--        no businesses, and makes sure each one has its sweep and its 7:00
--        morning email in its own time zone. This lists each business's id,
--        organization and time zone, and nothing else; each business's own
--        jobs then run bound to it, as every job does. The worker alone may
--        call it (as private.organization_timezones, 0029).
-- =============================================================================

create or replace function private.workspace_timezones()
returns table (workspace_id uuid, organization_id uuid, timezone text)
language sql stable security definer set search_path = '' as $$
  select w.id, w.organization_id, w.timezone
  from app.workspaces w
  order by w.id
$$;

revoke all on function private.workspace_timezones() from public;
grant execute on function private.workspace_timezones() to service_actor;
