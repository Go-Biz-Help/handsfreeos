-- =============================================================================
-- 0055 · When each detail last changed. Two people can edit the same customer
--        with no signal, and "newest wins" has to be decided per detail, not
--        per row: the phone's new email and the web's new number a minute
--        later both stay. So the records people edit from a phone — people,
--        companies, leads, tasks and appointments — keep field_times, one
--        stamp per column that has been changed since: {"email":
--        "2026-09-21T14:03:11.402Z", ...}. The update commands write it in the
--        same statement as the change, with the moment the change was really
--        made (corrected for the phone's clock, never later than now), and
--        compare against it before applying an edit made earlier. No trigger
--        stamps it: a trigger only knows when a row was written, not when the
--        person made the change. Nothing that already guards these tables
--        reads it; set_updated_at still stamps updated_at on every write, as
--        it should, since every write of field_times comes with a change.
--        Keys are column names; a column never edited has no stamp, and an
--        edit it can't compare against applies.
-- =============================================================================

alter table app.people
  add column field_times jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_times) = 'object' and pg_column_size(field_times) <= 16384);
alter table app.companies
  add column field_times jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_times) = 'object' and pg_column_size(field_times) <= 16384);
alter table app.leads
  add column field_times jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_times) = 'object' and pg_column_size(field_times) <= 16384);
alter table app.tasks
  add column field_times jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_times) = 'object' and pg_column_size(field_times) <= 16384);
alter table app.appointments
  add column field_times jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_times) = 'object' and pg_column_size(field_times) <= 16384);

comment on column app.people.field_times is
  'When each column last changed, by the moment the person made the change: {column: ISO time}. Written by the update commands, never by a trigger.';
comment on column app.companies.field_times is
  'When each column last changed, by the moment the person made the change: {column: ISO time}. Written by the update commands, never by a trigger.';
comment on column app.leads.field_times is
  'When each column last changed, by the moment the person made the change: {column: ISO time}. Written by the update commands, never by a trigger.';
comment on column app.tasks.field_times is
  'When each column last changed, by the moment the person made the change: {column: ISO time}. Written by the update commands, never by a trigger.';
comment on column app.appointments.field_times is
  'When each column last changed, by the moment the person made the change: {column: ISO time}. Written by the update commands, never by a trigger.';

-- ---------- grants ----------
-- people, companies, leads and tasks are granted update on the whole table (0006, and 0024 for the worker), which
-- covers the new column. Appointments name their columns for people (0016), so the stamp joins that list; the
-- worker's table-wide update already covers it.
grant update (field_times) on app.appointments to authenticated;
