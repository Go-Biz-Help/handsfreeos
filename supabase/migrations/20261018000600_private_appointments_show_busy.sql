-- =============================================================================
-- A private record's appointments show only as busy (Real Estate round two,
-- step 1).
--
--        Chris decided in round one that an appointment on a private deal shows
--        to people who aren't on it only as busy, so nobody double-books. Round
--        one made no appointments, so it wasn't built; round two's tours are
--        appointments on a deal.
--
--        **Sealed.** An appointment on a private record is sealed, kept by the
--        same trigger as tasks and files (20261013002400), and so are its
--        customers' rows. Someone who doesn't see the record doesn't see the
--        appointment: not its title, notes or place, nor who it's with.
--
--        **Busy.** Who works it and when stays in appointment_staff and
--        appointment_resources, which say nothing about the deal, so every
--        booking still steers around it. private.private_busy() gives the
--        calendar those times, as "busy", for the people who can't open it.
--
--        **Only its people work it.** Someone on a sealed appointment's staff
--        must see its record, as a task's assignee must.
--
--        **Home cards** about a sealed appointment are sealed with it.
--
--        **Phones** stop receiving sealed appointments and their customers in
--        business_v1, in place, as round one did for tasks and files; the
--        people on a deal get them back with the phone's deal screens.
-- =============================================================================

alter table app.appointments add column sealed boolean not null default false;
alter table app.appointment_attendees add column sealed boolean not null default false;
comment on column app.appointments.sealed is
  'On a private record (Real Estate round two): seen only by the people who see that record; others see its time as busy (private.private_busy). Kept by a trigger.';
comment on column app.appointment_attendees.sealed is
  'On a sealed appointment: seen only by the people who see its record. Kept by a trigger from the appointment.';
create index appointments_sealed_idx on app.appointments (custom_record_id) where sealed;

create trigger appointments_sealed before insert or update of custom_record_id, sealed on app.appointments
  for each row execute function private.keep_sealed();

-- A customer's row follows its appointment.
create or replace function private.keep_attendee_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sealed := coalesce((select a.sealed from app.appointments a where a.id = new.appointment_id), false);
  return new;
end $$;
create trigger appointment_attendees_sealed before insert or update of appointment_id, sealed
  on app.appointment_attendees for each row execute function private.keep_attendee_sealed();

create or replace function private.seal_attendees()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.appointment_attendees t set sealed = new.sealed
  where t.appointment_id = new.id and t.sealed is distinct from new.sealed;
  return null;
end $$;
create trigger appointments_seal_attendees after update of sealed on app.appointments
  for each row when (new.sealed is distinct from old.sealed) execute function private.seal_attendees();

-- The sealed appointments in the businesses the caller can open that they may not see.
create or replace function private.unseen_sealed_appointments()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select a.id from app.appointments a
  where a.sealed and a.custom_record_id in (select private.unseen_private_records())
$$;
grant execute on function private.unseen_sealed_appointments() to authenticated, service_actor;

-- When the people the caller can't see are busy: a sealed appointment's staff and times, and nothing else.
create or replace function private.private_busy(p_ws uuid, p_users uuid[], p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.user_id, lower(s.during), upper(s.during)
  from app.appointment_staff s
  join app.appointments a on a.id = s.appointment_id
  where s.workspace_id = p_ws and s.active and s.user_id = any (p_users)
    and s.during && tstzrange(p_from, p_to)
    and a.sealed and a.status = 'scheduled'
    and a.id in (select private.unseen_sealed_appointments())
  order by lower(s.during), s.user_id
$$;
revoke execute on function private.private_busy(uuid, uuid[], timestamptz, timestamptz) from public;
grant execute on function private.private_busy(uuid, uuid[], timestamptz, timestamptz) to authenticated;

-- ---------- only the people on its record work a sealed appointment ----------
create or replace function private.guard_sealed_appointment_staff()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_record uuid;
  v_sealed boolean;
begin
  if tg_table_name = 'appointment_staff' then
    select a.custom_record_id, a.sealed into v_record, v_sealed from app.appointments a where a.id = new.appointment_id;
    if coalesce(v_sealed, false) and new.active and not private.user_sees_record(new.user_id, v_record) then
      raise exception 'That person isn''t on this record' using errcode = '23514',
        detail = 'appointment_staff_not_on_record';
    end if;
  elsif new.sealed and exists (
      select 1 from app.appointment_staff s
      where s.appointment_id = new.id and s.active and not private.user_sees_record(s.user_id, new.custom_record_id)) then
    raise exception 'Someone on this appointment isn''t on its record' using errcode = '23514',
      detail = 'appointment_staff_not_on_record';
  end if;
  return null;
end $$;

create constraint trigger appointment_staff_on_record after insert or update of user_id, active
  on app.appointment_staff for each row execute function private.guard_sealed_appointment_staff();
create constraint trigger appointments_staff_on_record after update of custom_record_id
  on app.appointments for each row execute function private.guard_sealed_appointment_staff();

-- ---------- Home cards about a sealed appointment ----------
create or replace function private.keep_attention_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.subject_type = 'task' then
    select t.custom_record_id into new.custom_record_id from app.tasks t where t.id = new.subject_id;
  elsif new.subject_type = 'addon_alert' then
    select a.custom_record_id into new.custom_record_id from app.addon_alerts a where a.id = new.subject_id;
  elsif new.subject_type = 'appointment' then
    select a.custom_record_id into new.custom_record_id from app.appointments a where a.id = new.subject_id;
  end if;
  new.sealed := new.custom_record_id is not null and private.record_is_private(new.custom_record_id);
  return new;
end $$;

-- ---------- their policies: sealed ones only for the people who see the record ----------
-- As they stood (20260915000200, and 20260918000700 for customers' sources), each with the record's privacy added.
drop policy appointments_select on app.appointments;
drop policy appointments_insert on app.appointments;
drop policy appointments_update on app.appointments;
create policy appointments_select on app.appointments for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (not sealed or not (custom_record_id in (select private.unseen_private_records()))));
create policy appointments_insert on app.appointments for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and source in ('staff', 'assistant', 'series')
    and (not sealed or not (custom_record_id in (select private.unseen_private_records()))));
create policy appointments_update on app.appointments for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write')
         and (not sealed or not (custom_record_id in (select private.unseen_private_records()))))
  with check (private.has_permission(workspace_id, 'appointments.write')
              and (not sealed or not (custom_record_id in (select private.unseen_private_records()))));

drop policy appointment_attendees_select on app.appointment_attendees;
drop policy appointment_attendees_insert on app.appointment_attendees;
drop policy appointment_attendees_update on app.appointment_attendees;
create policy appointment_attendees_select on app.appointment_attendees for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (not sealed or not (appointment_id in (select private.unseen_sealed_appointments()))));
create policy appointment_attendees_insert on app.appointment_attendees for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and source in ('staff', 'assistant', 'series') and reminder_state = '{}'::jsonb and reschedule_count = 0
    and (not sealed or not (appointment_id in (select private.unseen_sealed_appointments()))));
create policy appointment_attendees_update on app.appointment_attendees for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write')
         and (not sealed or not (appointment_id in (select private.unseen_sealed_appointments()))))
  with check (private.has_permission(workspace_id, 'appointments.write')
              and (not sealed or not (appointment_id in (select private.unseen_sealed_appointments()))));

-- Any appointment already on a private record (none on the hosted database when this was written).
update app.appointments a set sealed = true
where a.custom_record_id is not null and private.record_is_private(a.custom_record_id) and not a.sealed;
