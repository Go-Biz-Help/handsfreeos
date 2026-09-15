-- =============================================================================
-- 0036 · The AI teammate's bookings, part 2, and teammate drafts that go out
--        once.
--        People book as staff, through the Assistant, or as a repeat series;
--        only the worker writes the booking page's and the AI teammate's
--        bookings. appointments_insert already lists those three (0016). The
--        attendee and waitlist policies said "not the booking page"; they now
--        list the three too, so 'ai_teammate' (0035) is refused like
--        'booking_page'. Updates can't change a source (0016's immutable
--        triggers and column grants).
--        A teammate draft remembers when it went out (sent_at). The worker
--        sets it in the same transaction as the draft's bookings and message,
--        so a repeated approval never runs a reschedule or a cancellation
--        twice, even with no message to find. People's column grant on drafts
--        (0034) leaves it out.
-- =============================================================================

drop policy appointment_attendees_insert on app.appointment_attendees;
create policy appointment_attendees_insert on app.appointment_attendees for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and source in ('staff', 'assistant', 'series') and reminder_state = '{}'::jsonb and reschedule_count = 0);

drop policy waitlist_entries_insert on app.waitlist_entries;
create policy waitlist_entries_insert on app.waitlist_entries for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and status = 'waiting' and offer_expires_at is null and offer is null
    and source in ('staff', 'assistant', 'series'));

alter table app.ai_teammate_drafts
  add column sent_at timestamptz,
  add constraint ai_teammate_drafts_sent_check check (sent_at is null or status = 'approved');
