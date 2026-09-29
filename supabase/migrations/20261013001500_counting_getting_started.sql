-- =============================================================================
-- Counting Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §9):
-- how many businesses answered the quick questions, which steps they skip,
-- how many finish, and how many answered "Add them as you go". Every one of
-- these is a command, so its event is already in app.events; this is the
-- saved count over them, for the admin side's Getting started page. Matomo's
-- page views give the other half, the funnel through the wizard's pages.
--
-- Staff who read the directory (platform.businesses.read) get the counts;
-- anyone else gets no rows. Counts only: no business, person or answer.
--
-- One row per measure, with `step` set for skipped and brought_back:
--   started        businesses that answered the quick questions
--   as_you_go      businesses that answered "Add them as you go"
--   finished       businesses whose owner or admin finished the guide
--   finished_clean ... with nothing skipped
--   finished_team  teammates who finished their own list
--   hidden         people who hid the guide from Home
--   turned_off     businesses that turned Getting started off
--   skipped        per step: businesses (a business step) or people (their
--                  own step) that skipped it
--   brought_back   per step: the same, for bringing a skipped step back
-- =============================================================================

create function private.admin_onboarding_counts(p_since timestamptz)
returns table (measure text, step text, count bigint)
language sql stable security definer set search_path = '' as $$
  with e as (
    select e.event_type, e.workspace_id, e.actor_id, e.payload
    from app.events e
    where e.event_type like 'onboarding.%' and e.created_at > p_since
  ),
  -- A business step is the business's; a step on someone's own list is theirs.
  skips as (
    select e.payload ->> 'step' as step,
           (e.payload ->> 'skipped')::boolean as skipped,
           case when e.payload ->> 'for' = 'person'
                then e.workspace_id::text || ':' || coalesce(e.actor_id::text, '')
                else e.workspace_id::text end as subject
    from e where e.event_type = 'onboarding.step_skipped'
  ),
  counted as (
    select 'started' as measure, null::text as step, count(distinct e.workspace_id) as count
    from e where e.event_type = 'onboarding.answers_saved'
    union all
    select 'as_you_go', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.customers_as_you_go'
      and (e.payload ->> 'asYouGo')::boolean
    union all
    select 'finished', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business'
    union all
    select 'finished_clean', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business'
      and (e.payload ->> 'skipped')::int = 0
    union all
    select 'finished_team', null, count(distinct (e.workspace_id, e.actor_id))
    from e where e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'personal'
    union all
    select 'hidden', null, count(distinct (e.workspace_id, e.actor_id))
    from e where e.event_type = 'onboarding.view_changed' and (e.payload ->> 'hidden')::boolean
    union all
    select 'turned_off', null, count(distinct e.workspace_id)
    from e where e.event_type = 'onboarding.enabled_changed'
      and not (e.payload ->> 'enabled')::boolean
    union all
    select case when s.skipped then 'skipped' else 'brought_back' end, s.step,
           count(distinct s.subject)
    from skips s group by 1, 2
  )
  select c.measure, c.step, c.count from counted c
  where private.staff_can('platform.businesses.read')
$$;

revoke all on function private.admin_onboarding_counts(timestamptz) from public;
grant execute on function private.admin_onboarding_counts(timestamptz) to authenticated;
