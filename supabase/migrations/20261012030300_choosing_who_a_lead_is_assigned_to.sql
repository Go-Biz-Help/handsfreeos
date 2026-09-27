-- =============================================================================
-- Who a lead or a booking shows its bills to is for owners and admins to
-- choose (SEC-M5).
--
--        Being a lead's assignee, or staff on a booking, shows a member the
--        estimates and invoices on it (`private.money_member_viewers`). A
--        customer's team already takes records.assign to change (0104), but a
--        lead's assignee took only records.write, so a member could put
--        themselves on any lead and read its bills.
--
--        A lead is still handed on by anybody who works it (the Action
--        Center's Assign, as the member): to nobody, or to somebody who
--        already sees every bill or sees none. Making somebody a lead's
--        assignee when that would show them bills they can't otherwise see —
--        yourself included — takes records.assign. The same exemptions as
--        `guard_customer_team`: a new lead is anybody's to start (nothing on
--        it to see yet), and the system is not asked.
--
--        `appointment.reassign` asks the same two functions for a booking.
-- =============================================================================

-- Whether being on a record would show this person its bills: they read money and don't manage it. The same
-- test `private.money_member_viewers` puts everyone on a document through.
create or replace function private.sees_money_as_member(p_ws uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.workspace_access wa
    where wa.workspace_id = p_ws and wa.user_id = p_user
      and 'money.read' = any (wa.permissions) and not 'money.manage' = any (wa.permissions))
$$;

create or replace function private.guard_lead_assignee()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_user_id is distinct from old.assignee_user_id
     and new.assignee_user_id is not null
     and auth.uid() is not null
     and not coalesce(private.system_scope_workspace() = new.workspace_id, false)
     and not private.has_permission(new.workspace_id, 'records.assign')
     and private.sees_money_as_member(new.workspace_id, new.assignee_user_id) then
    raise exception 'Only owners and admins choose who sees a lead''s bills'
      using errcode = '42501', detail = 'lead_assign_managers_only';
  end if;
  return new;
end $$;
drop trigger if exists leads_guard_assignee on app.leads;
create trigger leads_guard_assignee before update of assignee_user_id on app.leads
  for each row execute function private.guard_lead_assignee();

-- Whether any invoice is tied to somebody booked on this appointment: the only bills a booking shows its staff.
-- Asked by a member who can't see those invoices, so it answers yes or no and nothing else.
create or replace function private.appointment_has_money(p_ws uuid, p_appointment uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.appointment_attendees a
    join app.invoices i on i.attendee_id = a.id
    where a.appointment_id = p_appointment and a.workspace_id = p_ws and i.workspace_id = p_ws)
$$;

revoke all on function
  private.sees_money_as_member(uuid, uuid), private.guard_lead_assignee(),
  private.appointment_has_money(uuid, uuid)
  from public;
-- The trigger function is only ever run by its trigger, so nobody is granted it.
grant execute on function
  private.sees_money_as_member(uuid, uuid), private.appointment_has_money(uuid, uuid)
  to authenticated, service_actor;
