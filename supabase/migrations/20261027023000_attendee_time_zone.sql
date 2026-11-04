-- =============================================================================
-- A customer's own time zone, kept on their booking.
--
--        Chris asked on 2026-11-03 for a time zone on event and calendar
--        times. For what customers see he said: "the timezone should try to
--        always show in the viewer's timezone but if it doesn't know it it
--        defaults to the one set by the business".
--
--        appointment_attendees.timezone is that customer's zone when it is
--        known: the zone the booking page showed them (their device's, or the
--        one they changed it to), or the zone a teammate set the time in for
--        them (the Time zone pick, when it isn't the calendar's own). Their
--        confirmation, reminders and other texts and emails tell the time in
--        it. Left empty, the worker uses the zone of their US address, then
--        the calendar's (core `customerTimeZone`).
--
--        Only added: nothing reads it until the code that writes it ships.
--        The phone doesn't keep it (sync-config.yaml lists its columns).
-- =============================================================================

alter table app.appointment_attendees
  add column timezone text check (timezone is null or private.is_timezone(timezone));

comment on column app.appointment_attendees.timezone is
  'The customer''s own time zone for this booking: the booking page''s, or the zone a teammate set the time in. Empty: their address''s zone, then the calendar''s.';

-- A teammate may set it (booking or moving a visit on the customer's clock), like the rest of how to reach them.
grant update (timezone) on app.appointment_attendees to authenticated;
