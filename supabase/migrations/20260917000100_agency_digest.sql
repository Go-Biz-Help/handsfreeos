-- =============================================================================
-- 0029 · The daily agency digest. Each morning the worker emails an
--        organization's owners and admins about its businesses that need a
--        look (failed workflow runs, approvals waiting, paused workflows,
--        templates behind). Its planning job runs with an empty scope, which
--        sees no organizations, so this lists them with the time zone their
--        digest goes out in, and nothing else: the one most of the
--        organization's businesses use (the earliest business breaks a tie),
--        or America/Chicago when it has none. Each organization's digest then
--        reads one business at a time, bound to it, as every job does.
-- =============================================================================

create or replace function private.organization_timezones(p_org uuid default null)
returns table (organization_id uuid, timezone text)
language sql stable security definer set search_path = '' as $$
  select o.id, coalesce((
    select w.timezone from app.workspaces w
    where w.organization_id = o.id
    group by w.timezone
    order by count(*) desc, min(w.created_at), w.timezone
    limit 1), 'America/Chicago')
  from app.organizations o
  where p_org is null or o.id = p_org
  order by o.id
$$;

revoke all on function private.organization_timezones(uuid) from public;
grant execute on function private.organization_timezones(uuid) to service_actor;
