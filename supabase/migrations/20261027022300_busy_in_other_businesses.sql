-- =============================================================================
-- Someone booked in one of their businesses is busy in their others.
--
--        Chris asked on 2026-11-03 that a person on several calendars, once
--        booked on one, shows busy on the others. Inside one business that
--        was already so: availability reads each person's bookings from every
--        calendar, and appointment_staff_no_overlap keeps them in one place
--        at a time. Across businesses it wasn't: each business books its
--        people separately, and RLS keeps each business's appointments its
--        own.
--
--        **Times only.** private.busy_elsewhere() gives a business, for its
--        own people, when they're booked in their other businesses: the
--        visit with its buffers and travel, and nothing else. Not the other
--        business, the customer, the calendar or what it is. The calendar
--        then treats those times like a Google or Outlook busy time: online
--        booking doesn't offer them, and staff booking by hand hear about it
--        first.
--
--        **Only its own people.** Someone who works in the business (a
--        member, or an owner or admin of its organization, as
--        private.workspace_has_user), asked by someone who can open it, or by
--        the worker working for it.
-- =============================================================================

create or replace function private.busy_elsewhere(p_ws uuid, p_users uuid[], p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.user_id, lower(s.blocked), upper(s.blocked)
  from app.appointment_staff s
  where (p_ws in (select private.accessible_workspace_ids()) or p_ws = private.system_scope_workspace())
    and s.workspace_id <> p_ws and s.active and s.user_id = any (p_users)
    and s.blocked && tstzrange(p_from, p_to)
    and private.workspace_has_user(p_ws, s.user_id)
  order by lower(s.blocked), s.user_id
$$;
comment on function private.busy_elsewhere(uuid, uuid[], timestamptz, timestamptz) is
  'When a business''s own people are booked in their other businesses, as times only (with buffers and travel). For someone who can open the business, or the worker working for it.';
revoke execute on function private.busy_elsewhere(uuid, uuid[], timestamptz, timestamptz) from public;
grant execute on function private.busy_elsewhere(uuid, uuid[], timestamptz, timestamptz) to authenticated, service_actor;
