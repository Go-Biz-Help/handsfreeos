-- =============================================================================
-- A form keeps the `ref` its link was opened with (docs/outreach.md, the demo
-- link): Social Outreach sends a form that books a time, such as a recruiting
-- page, as a playbook's link, with `?ref=` naming who sent it to whom.
--
--        The sheet keeps it when it starts, so it holds when they stop partway
--        and come back on another link, and a time booked on the form keeps it
--        on the booking (appointment_attendees.link_ref), as the booking page
--        does. The demo then counts by itself, and so does a partner's link.
-- =============================================================================

alter table app.form_responses
  add column link_ref text check (link_ref is null or link_ref ~ '^[A-Za-z0-9_-]{1,64}$');

-- People read it with the rest of a sheet; only the worker writes it.
grant select (link_ref) on app.form_responses to authenticated;
