-- =============================================================================
-- Social Outreach (outreach): networks in the app
-- (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Build order" step 3;
-- docs/outreach.md, "Each network is in the app").
--
--        Results add "by network" beside "by playbook" and "by offer
--        version": `private.outreach_numbers` gives each count's network
--        too, from the profile the person was reached on. It's dropped and
--        made again, since a function's result can't gain a column in
--        place; everything that reads it names its columns, so the code
--        running now reads it the same.
--
--        The setup gets a step to pick networks (`networks`), between the
--        team's rules and the person's own settings.
--
-- Only widens: a column more in a function's result, and a check that
-- takes one more step.
-- =============================================================================

alter table addon_outreach.setup drop constraint setup_reached_check;
alter table addon_outreach.setup add constraint setup_reached_check
  check (reached in ('playbooks', 'ready', 'rules', 'networks', 'settings', 'extension', 'groups'));

-- The three numbers in [p_from, p_to), as before (20261027006600), each by
-- the network the person was reached on as well.
drop function private.outreach_numbers(uuid, uuid, boolean, timestamptz, timestamptz);
create function private.outreach_numbers(
  p_ws uuid, p_user uuid, p_everyone boolean, p_from timestamptz, p_to timestamptz)
returns table (
  platform text, playbook_id uuid, offer_version integer, messages int, positive int, booked int)
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
  select coalesce(p.platform::text, 'facebook'), o.playbook_id, f.offer_version,
    (count(*) filter (where c.what = 'message'))::int,
    (count(*) filter (where c.what = 'positive'))::int,
    (count(*) filter (where c.what = 'booked'))::int
  from counted c
  left join addon_outreach.profiles p on p.id = c.profile_id
  left join addon_outreach.opener_uses o
    on o.workspace_id = p_ws and o.user_id = c.user_id and o.profile_id = c.profile_id
  left join addon_outreach.follow_ups f
    on f.workspace_id = p_ws and f.user_id = c.user_id and f.profile_id = c.profile_id
  where case when p_everyone
    then (current_setting('role', true) = 'service_actor' and p_ws = private.system_scope_workspace())
      or private.has_permission(p_ws, 'outreach.manage')
    else private.outreach_may_count(p_ws, array[p_user]) end
  group by coalesce(p.platform::text, 'facebook'), o.playbook_id, f.offer_version
$$;
revoke all on function private.outreach_numbers(uuid, uuid, boolean, timestamptz, timestamptz) from public;
grant execute on function private.outreach_numbers(uuid, uuid, boolean, timestamptz, timestamptz)
  to authenticated, service_actor;
