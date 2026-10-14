-- =============================================================================
-- Video meetings, step 7: Google Meet transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §8).
--        Reading a Meet call's transcript needs one more Google permission
--        than the calendar does, so it's opt-in: a person asks for it from
--        their Google calendar card, which signs in to Google again with that
--        permission added. Their calendar connection then holds it (scopes).
--        Transcripts can now come from Google Meet as well as Zoom.
-- =============================================================================

-- A sign-in that asks for Meet transcripts too (set when it starts; read when it comes back).
alter table app.calendar_connections add column meet_transcripts boolean not null default false;
grant select (meet_transcripts) on app.calendar_connections to authenticated;

alter table app.appointment_transcripts drop constraint appointment_transcripts_provider_check,
  add constraint appointment_transcripts_provider_check check (provider in ('zoom', 'google_meet'));
