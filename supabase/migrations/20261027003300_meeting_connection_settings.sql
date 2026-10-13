-- =============================================================================
-- Video meetings, step 4: what a connected Zoom account's settings mean for
--        transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §7). The
--        worker reads the account's plan and recording settings after it
--        connects, once a day, and when someone presses Check again, and keeps
--        the problems it found (codes; core words them) for Settings → My
--        calendar. People read them like the rest of the connection's state.
-- =============================================================================

alter table app.meeting_connections
  add column settings_checked_at timestamptz,
  add column settings_problems text[] not null default '{}'
    check (cardinality(settings_problems) <= 20);

grant select (settings_checked_at, settings_problems) on app.meeting_connections to authenticated;
