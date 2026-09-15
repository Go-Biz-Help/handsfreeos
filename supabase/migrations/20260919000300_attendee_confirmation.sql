-- =============================================================================
-- 0041 · Confirming an appointment. A customer confirms a one-on-one booking
--        by replying C to the day-before text, with the Confirm button in the
--        reminder email or on their manage page, or by telling the AI
--        teammate; staff can also mark it confirmed for them. The
--        confirmation, and when HandsFreeOS asked for it, live on the
--        attendee (the seat), and go when the booking moves: the
--        appointment's start changes, or a cancelled seat is taken again
--        (a seat that moves to another session is a new or re-taken seat
--        there, never a changed appointment_id). The worker records
--        customers' confirmations and the asks. People may record a
--        confirmation only as staff, in their own name, and may take back
--        only a staff mark: nobody fakes, changes or removes a customer's
--        confirmation by hand.
-- =============================================================================

alter table app.appointment_attendees
  -- When and how it was confirmed: sms (a C, or a YES while an ask is open), link (the Confirm button), staff (a
  -- person, named in confirmed_by) or ai (the AI teammate heard it from the customer).
  add column confirmed_at timestamptz,
  add column confirmed_via text check (confirmed_via is null or confirmed_via in ('sms', 'link', 'staff', 'ai')),
  add column confirmed_by uuid references app.users (id) on delete set null,
  -- When HandsFreeOS last asked the customer to confirm. While the ask is open a YES reply confirms too.
  add column confirm_asked_at timestamptz,
  add constraint appointment_attendees_confirmed_check check ((confirmed_at is null) = (confirmed_via is null)),
  add constraint appointment_attendees_confirmed_by_check
    check (confirmed_by is null or confirmed_via is not distinct from 'staff');

-- A text reply finds the sender's outstanding asks: asked, not yet confirmed.
create index appointment_attendees_confirm_asks_idx on app.appointment_attendees (workspace_id, contact_phone_e164)
  where confirm_asked_at is not null and confirmed_at is null;

-- ---------- who may confirm ----------
-- People (attendee.confirm runs as the person) may mark an unconfirmed seat confirmed as 'staff' in their own
-- name, with the database's clock, and take back a staff mark. A seat they add starts unconfirmed and never
-- asked. Customers' confirmations (sms, link) and the AI teammate's are the worker's alone: people can neither
-- make one, change one, nor remove one. The test is on current_user, which no role can fake, so this function
-- must stay SECURITY INVOKER.
create or replace function private.guard_attendee_confirmation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.confirmed_at is not null or new.confirmed_via is not null or new.confirmed_by is not null
       or new.confirm_asked_at is not null then
      raise exception 'A new booking starts unconfirmed' using errcode = '42501', detail = 'attendee_confirmation_protected';
    end if;
    return new;
  end if;
  if (new.confirmed_at, new.confirmed_via, new.confirmed_by) is not distinct from
     (old.confirmed_at, old.confirmed_via, old.confirmed_by) then
    return new;
  end if;
  if old.confirmed_at is null and new.confirmed_via = 'staff' and new.confirmed_by = auth.uid() then
    new.confirmed_at := now();
    return new;
  end if;
  if old.confirmed_via = 'staff' and new.confirmed_at is null and new.confirmed_via is null and new.confirmed_by is null then
    return new;
  end if;
  raise exception 'People confirm a booking only as staff, in their own name'
    using errcode = '42501', detail = 'attendee_confirmation_protected';
end $$;
create trigger appointment_attendees_confirmation_guard before insert or update on app.appointment_attendees
  for each row execute function private.guard_attendee_confirmation();

-- ---------- a booking that moves needs confirming again ----------
-- A seat re-taken after it was cancelled (how a seat arrives back in a session) starts over, and so would one that
-- changed appointments (appointment_id is immutable today; this keeps it true if that ever changes). It fires after
-- the guard (triggers run in name order), so a person who re-takes a seat clears it without writing the columns.
create or replace function private.reset_attendee_confirmation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.appointment_id is distinct from old.appointment_id
     or (old.status = 'cancelled' and new.status <> 'cancelled') then
    new.confirmed_at := null;
    new.confirmed_via := null;
    new.confirmed_by := null;
    new.confirm_asked_at := null;
  end if;
  return new;
end $$;
create trigger appointment_attendees_confirmation_reset before update of appointment_id, status on app.appointment_attendees
  for each row execute function private.reset_attendee_confirmation();

-- A new start time clears every seat's confirmation and ask. SECURITY DEFINER: it runs as the table's owner, so a
-- person who moves an appointment clears them without being able to write them.
create or replace function private.reset_confirmations_on_move()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.starts_at is distinct from old.starts_at then
    update app.appointment_attendees a
    set confirmed_at = null, confirmed_via = null, confirmed_by = null, confirm_asked_at = null
    where a.appointment_id = new.id and (a.confirmed_at is not null or a.confirm_asked_at is not null);
  end if;
  return null;
end $$;
create trigger appointments_reset_confirmations after update of starts_at on app.appointments
  for each row execute function private.reset_confirmations_on_move();

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_attendee_confirmation_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if new.confirmed_by is not null and not private.workspace_has_user(new.workspace_id, new.confirmed_by) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger appointment_attendees_confirmation_refs before insert or update of confirmed_by on app.appointment_attendees
  for each row execute function private.check_attendee_confirmation_refs();

-- ---------- grants ----------
-- People get the three confirmation columns, and nothing more: the guard narrows them to a staff mark in their own
-- name (or taking one back). Column grants alone can't say which values are allowed, and a definer function would
-- be a second path around the kernel. confirm_asked_at is not granted: only HandsFreeOS asks. Inserts keep the
-- grant they had (0015), and the guard keeps a new seat unconfirmed. The worker's table-wide update (0015) covers
-- customers' confirmations and the asks.
grant update (confirmed_at, confirmed_via, confirmed_by) on app.appointment_attendees to authenticated;

-- ---------- function privileges ----------
revoke all on function
  private.guard_attendee_confirmation(), private.reset_attendee_confirmation(), private.reset_confirmations_on_move(),
  private.check_attendee_confirmation_refs()
  from public;
grant execute on function
  private.guard_attendee_confirmation(), private.reset_attendee_confirmation(), private.reset_confirmations_on_move(),
  private.check_attendee_confirmation_refs()
  to authenticated, service_actor;
