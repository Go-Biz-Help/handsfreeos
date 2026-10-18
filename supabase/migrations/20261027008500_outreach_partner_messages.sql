-- =============================================================================
-- Social Outreach (outreach): reaching partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 1; docs/outreach.md
-- decision 81).
--
--        A partner on the person's list is warmed up with a like, then
--        asked whether they're open to partnering, followed up at most
--        twice a week apart, sent the details after a yes, and answered
--        when they write. Each of those messages goes through `sends` like
--        the rest, so its kinds take the partner's four; and each always
--        waits for the person's OK, one at a time.
--
--        `partners` keeps how far that has come: the follow-ups sent and
--        when the last went, when the details went, and what the AI read in
--        their latest answer (yes, a question, not now, no), with when.
--
--        The main offer's numbers (decision 70) count first messages to
--        customers only: an ask to partner is no pitch of the offer, so
--        `private.outreach_numbers_by_network` leaves out first messages to
--        someone the person asked to partner. Its result is the same shape,
--        so it's replaced in place.
--
-- Only adds and narrows a count: four kinds more that `sends` takes, five columns on partners, each empty until
-- set, and the numbers leave partners out.
-- =============================================================================

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in',
    'partner_ask', 'partner_follow_up', 'partner_details', 'partner_reply'));

alter table addon_outreach.partners
  add column follow_ups smallint not null default 0 check (follow_ups between 0 and 10),
  add column followed_at timestamptz,
  add column details_at timestamptz,
  add column answer text check (answer is null or answer in ('yes', 'question', 'later', 'no')),
  add column answered_at timestamptz;

create or replace function private.outreach_numbers_by_network(
  p_ws uuid, p_user uuid, p_everyone boolean, p_from timestamptz, p_to timestamptz)
returns table (
  platform text, playbook_id uuid, offer_version integer, messages int, positive int, booked int)
language sql stable security definer set search_path = '' as $$
  with firsts as (
    select t.user_id, t.profile_id, t.at
    from addon_outreach.touches t
    where t.workspace_id = p_ws and (p_everyone or t.user_id = p_user) and t.step = 'first_message'
      -- An ask to partner (decision 81) is no pitch of the offer.
      and not exists (select 1 from addon_outreach.partners pa
        where pa.profile_id = t.profile_id and pa.user_id = t.user_id and pa.asked_at is not null)
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
