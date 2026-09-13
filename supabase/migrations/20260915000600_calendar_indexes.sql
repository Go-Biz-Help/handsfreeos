-- =============================================================================
-- 0020 · Calendar indexes. Every foreign key on the calendar tables from 0015
--        to 0019 gets an index that leads with its column, where none did, so
--        deleting or changing the row it points at (a workspace, a person, a
--        service, a customer) finds the rows that refer to it without reading
--        the whole table. Keys an existing index already leads with are left
--        as they are. A partial index (one with a WHERE) doesn't count: it only
--        holds some of the rows, so those keys get a plain index too.
-- =============================================================================

-- ---------- 0015 · catalogs, calendars and hours ----------
create index schedules_created_by_idx on app.schedules (created_by);
create index schedule_exceptions_workspace_id_idx on app.schedule_exceptions (workspace_id);
create index schedule_exceptions_created_by_idx on app.schedule_exceptions (created_by);
create index resources_created_by_idx on app.resources (created_by);
create index services_created_by_idx on app.services (created_by);
create index service_staff_workspace_id_idx on app.service_staff (workspace_id);
create index service_resources_workspace_id_idx on app.service_resources (workspace_id);
create index territories_created_by_idx on app.territories (created_by);
create index territory_members_workspace_id_idx on app.territory_members (workspace_id);
create index booking_sites_created_by_idx on app.booking_sites (created_by);
create index calendars_owner_user_id_idx on app.calendars (owner_user_id);
create index calendars_created_by_idx on app.calendars (created_by);
create index calendar_revisions_workspace_id_idx on app.calendar_revisions (workspace_id);
create index calendar_revisions_changed_by_idx on app.calendar_revisions (changed_by);
create index calendar_members_user_id_idx on app.calendar_members (user_id);
create index calendar_services_workspace_id_idx on app.calendar_services (workspace_id);
create index calendar_resources_workspace_id_idx on app.calendar_resources (workspace_id);
create index calendar_assignment_state_workspace_id_idx on app.calendar_assignment_state (workspace_id);
create index calendar_assignment_state_user_id_idx on app.calendar_assignment_state (user_id);

-- ---------- 0016 · appointments, attendees, series and the waitlist ----------
create index appointment_series_workspace_id_idx on app.appointment_series (workspace_id);
create index appointment_series_created_by_idx on app.appointment_series (created_by);
create index appointments_service_id_idx on app.appointments (service_id);
create index appointments_owner_user_id_idx on app.appointments (owner_user_id);
create index appointments_created_by_idx on app.appointments (created_by);
create index appointment_resources_workspace_id_idx on app.appointment_resources (workspace_id);
create index appointment_attendees_workspace_id_idx on app.appointment_attendees (workspace_id);
create index appointment_attendees_created_by_idx on app.appointment_attendees (created_by);
create index waitlist_entries_workspace_id_idx on app.waitlist_entries (workspace_id);
create index waitlist_entries_person_id_idx on app.waitlist_entries (person_id);
create index waitlist_entries_created_by_idx on app.waitlist_entries (created_by);
create index appointment_calendar_events_workspace_id_idx on app.appointment_calendar_events (workspace_id);
create index appointment_calendar_events_user_id_idx on app.appointment_calendar_events (user_id);

-- ---------- 0017 · calendar connections and busy times ----------
create index calendar_connections_created_by_idx on app.calendar_connections (created_by);
create index calendar_busy_blocks_user_id_idx on app.calendar_busy_blocks (user_id);

-- ---------- keys that only a partial index covered ----------
create index resources_workspace_id_idx on app.resources (workspace_id);
create index services_workspace_id_idx on app.services (workspace_id);
create index appointment_staff_workspace_id_idx on app.appointment_staff (workspace_id);
create index waitlist_entries_appointment_id_idx on app.waitlist_entries (appointment_id);
create index calendar_connections_workspace_id_idx on app.calendar_connections (workspace_id);
