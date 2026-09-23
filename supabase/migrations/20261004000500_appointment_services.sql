-- =============================================================================
-- 0096 · More on one visit (M18 step 2). A visit holds one service; a customer
--        who asks "can you also change the filter while you're out?" now gets
--        the extra service added to the same visit: its name, its time (the
--        visit runs that much longer, when the team is free) and its price, as
--        the price list said then. The AI teammate adds them for the customer
--        it's talking to; the calendar shows them under the visit.
-- =============================================================================

create table app.appointment_services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  service_id uuid not null references app.services (id),
  -- As the service read when it was added, so a later rename or price change doesn't rewrite the visit.
  name text not null check (length(btrim(name)) between 1 and 200),
  duration_minutes integer not null check (duration_minutes between 0 and 720),
  price_cents integer check (price_cents >= 0),
  source text not null default 'staff' check (source in ('staff', 'ai_teammate')),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index appointment_services_appointment_idx on app.appointment_services (appointment_id, created_at);
create index appointment_services_service_idx on app.appointment_services (service_id);
create index appointment_services_workspace_idx on app.appointment_services (workspace_id);
create index appointment_services_created_by_idx on app.appointment_services (created_by) where created_by is not null;

create or replace function private.check_appointment_service_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not (
    exists (select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id)
    and exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id)
  ) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end;
$$;
create trigger appointment_services_check_refs before insert on app.appointment_services
  for each row execute function private.check_appointment_service_refs();

alter table app.appointment_services enable row level security;
create policy appointment_services_select on app.appointment_services for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy appointment_services_service_all on app.appointment_services for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.appointment_services to authenticated;
grant select, insert, delete on app.appointment_services to service_actor;
revoke all on app.appointment_services from anon;
revoke execute on function private.check_appointment_service_refs() from public;
