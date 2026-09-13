-- =============================================================================
-- 0016 · Appointments. One table holds every 1:1 booking, group session,
--        fixed-date event and series occurrence; people attach through staff,
--        attendee and resource rows, so reshaping a calendar never migrates
--        data, and each appointment keeps the revision's terms it was booked
--        under. Every staff and resource row carries its appointment's actual
--        time (`during`) and its time with buffers and travel (`blocked`),
--        kept in step by triggers, and an exclusion constraint on `during`
--        makes double-booking a person impossible whoever writes (buffers stay
--        a preference the engine checks). Also: recurring series, waitlists,
--        write-through state for people's own calendars, and the system
--        actor's right to create leads (a booking can open one). People with
--        appointments.write book, change and cancel; the booking page, reminder
--        state and provider event ids are the worker's.
-- =============================================================================

-- Exclusion constraints mixing uuid equality with range overlap need btree_gist's uuid operator class.
create extension if not exists btree_gist with schema extensions;

create type app.appointment_kind as enum ('booking', 'session');
create type app.appointment_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');
create type app.appointment_source as enum ('staff', 'assistant', 'booking_page', 'series');
create type app.appointment_staff_role as enum ('host', 'crew');
create type app.attendee_status as enum ('booked', 'cancelled', 'no_show', 'attended');
create type app.waitlist_status as enum ('waiting', 'offered', 'booked', 'expired', 'removed');

-- Calendars and services are archived, never deleted, while appointments point at them (the default
-- NO ACTION, so deleting a whole workspace still cascades; see 0015).

-- ---------- recurring series: the rule every occurrence was written from ----------
create table app.appointment_series (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id),
  -- {freq: weekly | monthly_date | monthly_nth, interval 1-12, weekdays, count <= 52, until <= 12 months, localTime}
  rule jsonb not null check (jsonb_typeof(rule) = 'object'),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index appointment_series_calendar_idx on app.appointment_series (calendar_id);
create trigger appointment_series_updated_at before update on app.appointment_series for each row execute function private.set_updated_at();
create trigger appointment_series_immutable before update on app.appointment_series for each row execute function private.forbid_tenant_column_change('workspace_id', 'calendar_id', 'created_by');

-- ---------- appointments ----------
create table app.appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id),
  -- The calendar revision whose terms (length, buffers, policies) this appointment keeps.
  calendar_revision integer not null check (calendar_revision >= 1),
  service_id uuid references app.services (id),
  kind app.appointment_kind not null default 'booking',
  title text not null check (length(btrim(title)) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Minutes blocked around the visit, travel included.
  buffer_before integer not null default 0 check (buffer_before between 0 and 720),
  buffer_after integer not null default 0 check (buffer_after between 0 and 720),
  capacity integer not null default 1 check (capacity between 1 and 1000),
  seats_taken integer not null default 0 check (seats_taken >= 0),
  status app.appointment_status not null default 'scheduled',
  location jsonb not null default '{}'::jsonb check (jsonb_typeof(location) = 'object'),
  series_id uuid references app.appointment_series (id) on delete set null,
  occurrence integer check (occurrence is null or occurrence between 1 and 52),
  owner_user_id uuid references app.users (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  source app.appointment_source not null default 'staff',
  notes text check (notes is null or length(notes) <= 5000),
  -- The caller's idempotency key: a double-clicked or retried booking lands once.
  client_id text check (client_id is null or length(client_id) between 1 and 64),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '7 days')
);
create index appointments_range_idx on app.appointments (workspace_id, starts_at, ends_at);
create index appointments_calendar_idx on app.appointments (calendar_id, starts_at);
create unique index appointments_series_occurrence on app.appointments (series_id, occurrence) where series_id is not null;
create index appointments_lead_idx on app.appointments (lead_id) where lead_id is not null;
create unique index appointments_client_unique on app.appointments (workspace_id, client_id) where client_id is not null;
create trigger appointments_updated_at before update on app.appointments for each row execute function private.set_updated_at();
create trigger appointments_immutable before update on app.appointments for each row execute function private.forbid_tenant_column_change('workspace_id', 'source', 'created_by');

-- ---------- who works it: the exclusion keeps one person from being in two places at once ----------
-- `during`, `blocked` and `active` are written by trigger from the appointment (anything a caller sends is
-- replaced); 'empty' defaults let callers leave them out. Only scheduled appointments hold time.
create table app.appointment_staff (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  role app.appointment_staff_role not null default 'host',
  during tstzrange not null default 'empty',
  blocked tstzrange not null default 'empty',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (appointment_id, user_id),
  -- Per workspace: someone who works for two businesses is booked by each separately.
  constraint appointment_staff_no_overlap exclude using gist (
    workspace_id extensions.gist_uuid_ops with =,
    user_id extensions.gist_uuid_ops with =,
    during with &&
  ) where (active)
);
-- Availability reads each person's time with buffers.
create index appointment_staff_blocked_idx on app.appointment_staff using gist (user_id extensions.gist_uuid_ops, blocked) where active;
create index appointment_staff_user_idx on app.appointment_staff (user_id);
create trigger appointment_staff_immutable before update on app.appointment_staff for each row execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'user_id');

-- What it uses. Quantities are checked by the engine under the resource's booking lock.
create table app.appointment_resources (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  resource_id uuid not null references app.resources (id),
  quantity integer not null default 1 check (quantity between 1 and 100),
  during tstzrange not null default 'empty',
  blocked tstzrange not null default 'empty',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (appointment_id, resource_id)
);
create index appointment_resources_blocked_idx on app.appointment_resources using gist (resource_id extensions.gist_uuid_ops, blocked) where active;
create index appointment_resources_resource_idx on app.appointment_resources (resource_id);
create trigger appointment_resources_immutable before update on app.appointment_resources for each row execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'resource_id');

-- ---------- who comes: one row for a 1:1 visit, many for a session ----------
create table app.appointment_attendees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  person_id uuid not null references app.people (id),
  status app.attendee_status not null default 'booked',
  seats integer not null default 1 check (seats between 1 and 100),
  intake jsonb not null default '{}'::jsonb check (jsonb_typeof(intake) = 'object'),
  -- How to reach them about this booking (the booking form never edits the customer record).
  contact_phone_e164 text check (contact_phone_e164 is null or contact_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  contact_email text check (contact_email is null or (contact_email = lower(contact_email) and position('@' in contact_email) > 1)),
  sms_ok boolean not null default false,
  -- Part of the signed manage link; raising it retires links already sent.
  manage_version integer not null default 1 check (manage_version >= 1),
  source app.appointment_source not null default 'staff',
  -- The worker's: which confirmations and reminders went out, and how often the customer rescheduled.
  reminder_state jsonb not null default '{}'::jsonb check (jsonb_typeof(reminder_state) = 'object'),
  reschedule_count integer not null default 0 check (reschedule_count >= 0),
  cancelled_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, person_id)
);
create index appointment_attendees_person_idx on app.appointment_attendees (person_id, appointment_id);
create trigger appointment_attendees_updated_at before update on app.appointment_attendees for each row execute function private.set_updated_at();
create trigger appointment_attendees_immutable before update on app.appointment_attendees for each row execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'person_id', 'source', 'created_by');

-- ---------- waitlists: a seat in a full session, or a wanted window for a 1:1 opening ----------
create table app.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  calendar_id uuid not null references app.calendars (id),
  appointment_id uuid references app.appointments (id) on delete cascade,
  wanted_from timestamptz,
  wanted_to timestamptz,
  person_id uuid not null references app.people (id),
  seats integer not null default 1 check (seats between 1 and 100),
  status app.waitlist_status not null default 'waiting',
  offer_expires_at timestamptz,
  position integer not null default 0,
  contact_phone_e164 text check (contact_phone_e164 is null or contact_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  contact_email text check (contact_email is null or (contact_email = lower(contact_email) and position('@' in contact_email) > 1)),
  sms_ok boolean not null default false,
  source app.appointment_source not null default 'staff',
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (appointment_id is not null or (wanted_from is not null and wanted_to > wanted_from))
);
create unique index waitlist_entries_one_live on app.waitlist_entries (appointment_id, person_id)
  where appointment_id is not null and status in ('waiting', 'offered');
create index waitlist_entries_queue_idx on app.waitlist_entries (calendar_id, status, position, created_at);
create index waitlist_entries_offers_idx on app.waitlist_entries (offer_expires_at) where status = 'offered';
create trigger waitlist_entries_updated_at before update on app.waitlist_entries for each row execute function private.set_updated_at();
create trigger waitlist_entries_immutable before update on app.waitlist_entries for each row execute function private.forbid_tenant_column_change('workspace_id', 'calendar_id', 'person_id', 'source', 'created_by');

-- People put someone on a waitlist, reorder it, book them or take them off; offers and expiry are the worker's.
create or replace function private.guard_waitlist_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status is distinct from new.status and new.status not in ('booked', 'removed') then
    raise exception 'Only HandsFreeOS offers a waitlist spot or lets one expire' using errcode = '42501', detail = 'waitlist_status_transition';
  end if;
  return new;
end $$;
create trigger waitlist_entries_update_guard before update on app.waitlist_entries for each row execute function private.guard_waitlist_update();

-- ---------- write-through to people's own Google or Outlook calendars (the worker's) ----------
create table app.appointment_calendar_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- References app.calendar_connections (0017 adds the foreign key once that table exists).
  connection_id uuid,
  provider_event_id text check (provider_event_id is null or length(provider_event_id) <= 1024),
  synced_at timestamptz,
  error text check (error is null or length(error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, user_id)
);
create trigger appointment_calendar_events_updated_at before update on app.appointment_calendar_events for each row execute function private.set_updated_at();
create trigger appointment_calendar_events_immutable before update on app.appointment_calendar_events for each row execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'user_id');

-- ---------- ranges follow the appointment ----------
-- A staff or resource row takes its ranges and `active` from its appointment on every write, so a
-- caller can neither forge them nor leave them stale.
create or replace function private.set_appointment_ranges()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  a record;
begin
  select ap.workspace_id, ap.starts_at, ap.ends_at, ap.buffer_before, ap.buffer_after, ap.status into a
  from app.appointments ap where ap.id = new.appointment_id;
  if not found or a.workspace_id <> new.workspace_id then
    raise exception 'Appointment must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  new.during := tstzrange(a.starts_at, a.ends_at, '[)');
  new.blocked := tstzrange(a.starts_at - make_interval(mins => a.buffer_before), a.ends_at + make_interval(mins => a.buffer_after), '[)');
  new.active := a.status = 'scheduled';
  return new;
end $$;
create trigger appointment_staff_ranges before insert or update on app.appointment_staff for each row execute function private.set_appointment_ranges();
create trigger appointment_resources_ranges before insert or update on app.appointment_resources for each row execute function private.set_appointment_ranges();

-- Moving, re-buffering, cancelling or restoring an appointment touches its rows so the trigger above
-- recomputes them; a move onto someone's booked time fails right here with 23P01.
create or replace function private.sync_appointment_ranges()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (old.starts_at, old.ends_at, old.buffer_before, old.buffer_after, old.status)
     is distinct from (new.starts_at, new.ends_at, new.buffer_before, new.buffer_after, new.status) then
    update app.appointment_staff s set active = s.active where s.appointment_id = new.id;
    update app.appointment_resources r set active = r.active where r.appointment_id = new.id;
  end if;
  return null;
end $$;
create trigger appointments_sync_ranges after update of starts_at, ends_at, buffer_before, buffer_after, status on app.appointments
  for each row execute function private.sync_appointment_ranges();

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_appointment_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_table_name = 'appointments' then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id)
      and (new.service_id is null or exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id))
      and (new.lead_id is null or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      and (new.series_id is null or exists (select 1 from app.appointment_series r where r.id = new.series_id and r.workspace_id = new.workspace_id))
      and (new.owner_user_id is null or private.workspace_has_user(new.workspace_id, new.owner_user_id));
  elsif tg_table_name = 'appointment_series' then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id);
  elsif tg_table_name = 'appointment_staff' then
    v_ok := private.workspace_has_user(new.workspace_id, new.user_id);
  elsif tg_table_name = 'appointment_resources' then
    v_ok := exists (select 1 from app.resources r where r.id = new.resource_id and r.workspace_id = new.workspace_id);
  elsif tg_table_name = 'appointment_attendees' then
    v_ok := exists (select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id)
      and exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id);
  elsif tg_table_name = 'waitlist_entries' then
    v_ok := exists (select 1 from app.calendars c where c.id = new.calendar_id and c.workspace_id = new.workspace_id)
      and (new.appointment_id is null or exists (select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id))
      and exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id);
  elsif tg_table_name = 'appointment_calendar_events' then
    v_ok := exists (select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id)
      and private.workspace_has_user(new.workspace_id, new.user_id);
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger appointments_check_refs before insert or update of calendar_id, service_id, lead_id, series_id, owner_user_id
  on app.appointments for each row execute function private.check_appointment_refs();
create trigger appointment_series_check_refs before insert on app.appointment_series for each row execute function private.check_appointment_refs();
create trigger appointment_staff_check_refs before insert on app.appointment_staff for each row execute function private.check_appointment_refs();
create trigger appointment_resources_check_refs before insert on app.appointment_resources for each row execute function private.check_appointment_refs();
create trigger appointment_attendees_check_refs before insert on app.appointment_attendees for each row execute function private.check_appointment_refs();
create trigger waitlist_entries_check_refs before insert or update of appointment_id on app.waitlist_entries for each row execute function private.check_appointment_refs();
create trigger appointment_calendar_events_check_refs before insert on app.appointment_calendar_events for each row execute function private.check_appointment_refs();

-- ---------- RLS: the team reads the calendar; appointments.write books and changes ----------
alter table app.appointment_series enable row level security;
alter table app.appointments enable row level security;
alter table app.appointment_staff enable row level security;
alter table app.appointment_resources enable row level security;
alter table app.appointment_attendees enable row level security;
alter table app.waitlist_entries enable row level security;
alter table app.appointment_calendar_events enable row level security;

-- Inserts are granted on the whole table (Drizzle names every column), so the policies hold the line on
-- what only the worker writes: the booking page as a source, reminder state, waitlist offers.
create policy appointment_series_select on app.appointment_series for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointment_series_insert on app.appointment_series for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid()));
create policy appointment_series_update on app.appointment_series for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_series_service_all on app.appointment_series for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy appointments_select on app.appointments for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointments_insert on app.appointments for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and source in ('staff', 'assistant', 'series'));
create policy appointments_update on app.appointments for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointments_service_all on app.appointments for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy appointment_staff_select on app.appointment_staff for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointment_staff_insert on app.appointment_staff for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_staff_update on app.appointment_staff for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_staff_delete on app.appointment_staff for delete to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_staff_service_all on app.appointment_staff for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy appointment_resources_select on app.appointment_resources for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointment_resources_insert on app.appointment_resources for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_resources_update on app.appointment_resources for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_resources_delete on app.appointment_resources for delete to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_resources_service_all on app.appointment_resources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy appointment_attendees_select on app.appointment_attendees for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointment_attendees_insert on app.appointment_attendees for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and source <> 'booking_page' and reminder_state = '{}'::jsonb and reschedule_count = 0);
create policy appointment_attendees_update on app.appointment_attendees for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy appointment_attendees_service_all on app.appointment_attendees for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy waitlist_entries_select on app.waitlist_entries for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy waitlist_entries_insert on app.waitlist_entries for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and status = 'waiting' and offer_expires_at is null and source <> 'booking_page');
create policy waitlist_entries_update on app.waitlist_entries for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy waitlist_entries_service_all on app.waitlist_entries for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy appointment_calendar_events_select on app.appointment_calendar_events for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointment_calendar_events_service_all on app.appointment_calendar_events for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- a booking can open a lead: the worker runs lead.create as the system ----------
create policy leads_service_insert on app.leads for insert to service_actor
  with check (workspace_id = private.system_scope_workspace());
grant insert on app.leads to service_actor;

-- ---------- grants ----------
grant select, insert on app.appointment_series, app.appointments, app.appointment_attendees, app.waitlist_entries
  to authenticated;
grant select, insert, delete on app.appointment_staff, app.appointment_resources to authenticated;
-- Updates name only what people may change (source, created_by, reminder state and offers stay the worker's).
grant update (rule) on app.appointment_series to authenticated;
grant update (calendar_id, calendar_revision, service_id, kind, title, starts_at, ends_at, buffer_before, buffer_after,
  capacity, seats_taken, status, location, series_id, occurrence, owner_user_id, lead_id, notes)
  on app.appointments to authenticated;
grant update (role) on app.appointment_staff to authenticated;
grant update (quantity) on app.appointment_resources to authenticated;
grant update (status, seats, intake, contact_phone_e164, contact_email, sms_ok, manage_version, cancelled_at)
  on app.appointment_attendees to authenticated;
grant update (status, position, seats, wanted_from, wanted_to, contact_phone_e164, contact_email, sms_ok)
  on app.waitlist_entries to authenticated;
grant select on app.appointment_calendar_events to authenticated;

grant select, insert, update on app.appointment_series, app.appointments, app.appointment_attendees,
  app.waitlist_entries to service_actor;
grant select, insert, update, delete on app.appointment_staff, app.appointment_resources,
  app.appointment_calendar_events to service_actor;
revoke all on app.appointment_series, app.appointments, app.appointment_staff, app.appointment_resources,
  app.appointment_attendees, app.waitlist_entries, app.appointment_calendar_events from anon;

-- ---------- function privileges ----------
revoke all on function
  private.guard_waitlist_update(), private.set_appointment_ranges(), private.sync_appointment_ranges(),
  private.check_appointment_refs()
  from public;
grant execute on function
  private.guard_waitlist_update(), private.set_appointment_ranges(), private.sync_appointment_ranges(),
  private.check_appointment_refs()
  to authenticated, service_actor;
