-- Retry all on every step handed over (docs/outreach.md, decision 143).
--
-- Social Outreach's Steps it needs you for had Retry only on a message or a
-- comment that didn't go. Now any step can be tried again: a friend or
-- connection request, a confirm, a like before a request, a comment the
-- extension writes itself. One of those goes back on Today's list for the
-- extension's next go (`retry_at`, when it was put back), and is off Steps it
-- needs you for meanwhile. Done, it's cleared as before; handed back, it waits
-- again; neither within NEED_RETRY_DAYS (3), it waits again on its own.
--
-- The counts for Waiting for you and the team view leave out one put back
-- lately: private.outreach_needs_counted, beside the old
-- private.outreach_needs_waiting, which the running code still calls until it
-- deploys. A later migration removes the old one.
--
-- Only adds: a column and a function.

alter table addon_outreach.needs add column retry_at timestamptz;

-- How many needs each person has shown, and the newest, as
-- private.outreach_needs_waiting, less those put back on Today's list since
-- p_retry_since (decision 143).
create or replace function private.outreach_needs_counted(
  p_ws uuid, p_users uuid[], p_since timestamptz, p_retry_since timestamptz)
returns table (user_id uuid, n int, newest timestamptz)
language sql stable security definer set search_path = '' as $$
  select n.user_id, count(*)::int, max(n.created_at)
  from addon_outreach.needs n
  where n.workspace_id = p_ws and n.user_id = any (p_users) and n.state = 'open'
    and (n.retry_at is null or n.retry_at < p_retry_since)
    and private.outreach_may_count(p_ws, p_users)
    and private.outreach_need_shown(n.workspace_id, n.user_id, n.profile_id, n.step, n.state, n.seen_at, p_since)
  group by n.user_id
$$;
revoke all on function private.outreach_needs_counted(uuid, uuid[], timestamptz, timestamptz) from public;
grant execute on function private.outreach_needs_counted(uuid, uuid[], timestamptz, timestamptz)
  to authenticated, service_actor;
