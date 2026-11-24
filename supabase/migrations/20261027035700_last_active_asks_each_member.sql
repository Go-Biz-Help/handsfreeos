-- =============================================================================
-- Admin → Businesses works out "last active" a member at a time (speed audit,
-- Nov 2026).
--        - "Last active" is the newest thing one of the business's own people
--          did themselves (20261027030300). It was found by reading every
--          event a person ever made in the business and taking the newest:
--          981 ms for the live database's 14 businesses, and the list asks
--          twice a business (the column, and the gone_quiet flag). The page
--          took 1.9 s, and it grows with every click anybody makes.
--        - Now it asks, for each member, "what is the newest thing you did
--          here?", and takes the newest answer. Each ask is one step down an
--          index: 2 ms for the same 14 businesses.
--        - The index is for that ask alone: a person's events in one business,
--          newest first. Without it a member of two businesses who works in
--          only one would have every event they ever made read to learn they
--          did nothing in the other. Only people's events are in it, about two
--          in three of the table.
--        - "Active this week" read a week of every business's events to count
--          the businesses (158 ms). It asks the same question now: is the
--          business's last active inside the week? One rule, in one place.
--        - Replaces functions only, with the same signatures and grants, and
--          adds one index. Nothing is dropped, and the answers are the same,
--          so it can go on before the code.
-- =============================================================================

create index if not exists events_member_recent_idx
  on app.events (workspace_id, actor_id, created_at desc)
  where actor_type = 'human';

-- The newest thing a member of the business did themselves. No permission check of its own: only the admin
-- functions call it, and they check. One probe of events_member_recent_idx a member.
create or replace function private.member_last_active(p_ws uuid)
returns timestamptz
language sql stable set search_path = '' as $$
  select max(newest.created_at)
  from app.workspace_memberships m
  cross join lateral (
    select e.created_at from app.events e
    where e.workspace_id = p_ws and e.actor_id = m.user_id and e.actor_type = 'human'
    order by e.created_at desc
    limit 1
  ) newest
  where m.workspace_id = p_ws
$$;

-- How many businesses there are, how many arrived this week, how many of their people did anything this week.
-- Practice businesses (20261027027400) are left out of all three. As in 20261027030300, except that the third
-- asks each business for its last active rather than reading the week's events.
create or replace function private.admin_business_totals()
returns table (businesses bigint, new_this_week bigint, active_this_week bigint)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.workspaces w join app.organizations o on o.id = w.organization_id
      where o.practice_ends_at is null),
    (select count(*) from app.workspaces w join app.organizations o on o.id = w.organization_id
      where o.practice_ends_at is null and w.created_at > now() - interval '7 days'),
    (select count(*) from app.workspaces w join app.organizations o on o.id = w.organization_id
      where o.practice_ends_at is null
        and private.member_last_active(w.id) > now() - interval '7 days')
  where private.staff_can('platform.businesses.read')
$$;
