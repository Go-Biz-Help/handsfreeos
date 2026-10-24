-- =============================================================================
-- Who joined the live session (funnels): attendance one person at a time.
--
--        Until now an appointment was done or a no-show as a whole, and every
--        attendee went with it. A group session needs each person: who opened
--        their Join link and when, and whether they attended or didn't show.
--
--        **Joining** is joined_at, set when the person opens their own Join
--        link (/j/<public_ref><code>, signed like the change-or-cancel link,
--        so nothing secret is kept) or a teammate ticks it. Their status stays
--        booked while the session runs: capacity, reminders and the rest read
--        booked as they always have.
--
--        **The end of a session** (a calendar's scheduled sessions, never a
--        one-on-one visit) marks everyone who was given a Join link: attended
--        when they opened it, no_show when they never did.
--        join_offered_at says they were given one; attendance_set_at says
--        their attendance was set for them alone, which marking the whole
--        appointment done or a no-show then leaves as it is.
-- =============================================================================

alter table app.appointment_attendees
  add column joined_at timestamptz,
  add column join_offered_at timestamptz,
  add column attendance_set_at timestamptz;

grant update (joined_at, attendance_set_at) on app.appointment_attendees to authenticated;

-- The attendees of sessions that ended, still booked, who were given a Join link: what the worker's sweep marks
-- attended (they joined) or no_show (they never did). Ended at least ten minutes ago, within the last three days.
-- Sessions only: somebody on a one-on-one video call may well have used the meeting's own address.
create or replace function private.attendance_to_close(p_limit integer)
returns table (attendee_id uuid, workspace_id uuid, organization_id uuid, joined boolean)
language sql stable security definer set search_path = '' as $$
  select aa.id, aa.workspace_id, w.organization_id, aa.joined_at is not null
  from app.appointment_attendees aa
    join app.appointments a on a.id = aa.appointment_id
    join app.workspaces w on w.id = aa.workspace_id
  where aa.status = 'booked'
    and aa.join_offered_at is not null
    and a.status <> 'cancelled'
    and a.kind = 'session'
    and a.ends_at < now() - interval '10 minutes'
    and a.ends_at > now() - interval '3 days'
  order by a.ends_at
  limit greatest(1, least(p_limit, 500))
$$;

create index appointment_attendees_join_offered_idx on app.appointment_attendees (appointment_id)
  where join_offered_at is not null and status = 'booked';

revoke all on function private.attendance_to_close(integer) from public;
grant execute on function private.attendance_to_close(integer) to service_actor;
