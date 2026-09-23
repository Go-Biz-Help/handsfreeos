-- =============================================================================
-- 0098 · Jobs (M18 step 4). A job is the work a customer is waiting on: one
--        visit, or a project of several. Every booked visit starts one of its
--        own (the booking code makes it), and staff can gather other visits
--        into it. A job has a status the customer hears about — on the way,
--        started, waiting on parts, done — and a note the customer may see.
--
--        Visits already booked get a job each here: done for a completed visit,
--        cancelled for a cancelled one, scheduled otherwise.
--
--        Open jobs go to the phone (PowerSync), where techs tap On my way.
-- =============================================================================

create table app.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid references app.people (id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 200),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'on_the_way', 'in_progress', 'waiting_on_parts', 'done', 'cancelled')),
  -- What the customer may be told about it ("waiting on the compressor, due Friday").
  customer_note text check (customer_note is null or length(customer_note) <= 500),
  status_changed_at timestamptz,
  status_changed_by uuid references app.users (id) on delete set null,
  -- On the way: when it should get there, from the driving time the worker looked up.
  eta_at timestamptz,
  open boolean generated always as (status not in ('done', 'cancelled')) stored,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_workspace_idx on app.jobs (workspace_id, open);
create index jobs_person_idx on app.jobs (person_id) where person_id is not null;
create index jobs_status_changed_by_idx on app.jobs (status_changed_by) where status_changed_by is not null;
create index jobs_created_by_idx on app.jobs (created_by) where created_by is not null;
create trigger jobs_updated_at before update on app.jobs for each row execute function private.set_updated_at();
create trigger jobs_immutable before update on app.jobs for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

create or replace function private.check_job_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.person_id is not null
    and not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end;
$$;
create trigger jobs_check_refs before insert or update of person_id on app.jobs
  for each row execute function private.check_job_refs();
revoke execute on function private.check_job_refs() from public;

alter table app.jobs enable row level security;
create policy jobs_select on app.jobs for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy jobs_insert on app.jobs for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy jobs_update on app.jobs for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy jobs_delete on app.jobs for delete to authenticated
  using (private.has_permission(workspace_id, 'appointments.write'));
create policy jobs_service_all on app.jobs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert, delete on app.jobs to authenticated;
grant update (person_id, title, status, customer_note, status_changed_at, status_changed_by, eta_at)
  on app.jobs to authenticated;
grant select, insert, update, delete on app.jobs to service_actor;
revoke all on app.jobs from anon;

-- Each visit belongs to one job.
alter table app.appointments add column job_id uuid references app.jobs (id) on delete set null;
create index appointments_job_idx on app.appointments (job_id) where job_id is not null;
grant update (job_id) on app.appointments to authenticated;

create or replace function private.check_appointment_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_id is not null
    and not exists (select 1 from app.jobs j where j.id = new.job_id and j.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end;
$$;
create trigger appointments_check_job before insert or update of job_id on app.appointments
  for each row execute function private.check_appointment_job();
revoke execute on function private.check_appointment_job() from public;

-- A job whose visits are all cancelled is cancelled too (the cancellation notice already told the customer).
create or replace function private.cancel_empty_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_id is not null and new.status = 'cancelled' and old.status is distinct from 'cancelled'
    and not exists (select 1 from app.appointments a
      where a.job_id = new.job_id and a.id <> new.id and a.status <> 'cancelled') then
    update app.jobs set status = 'cancelled', status_changed_at = now(), eta_at = null
    where id = new.job_id and status <> 'cancelled';
  end if;
  return new;
end;
$$;
create trigger appointments_cancel_empty_job after update of status on app.appointments
  for each row execute function private.cancel_empty_job();
revoke execute on function private.cancel_empty_job() from public;

-- A job for every visit booked before now.
do $$
declare
  r record;
  v_job uuid;
begin
  for r in
    select a.id, a.workspace_id, a.title, a.status, a.created_by,
      (select t.person_id from app.appointment_attendees t where t.appointment_id = a.id
        order by t.created_at, t.id limit 1) as person_id
    from app.appointments a
    where a.kind = 'booking' and a.job_id is null
  loop
    insert into app.jobs (workspace_id, person_id, title, status, created_by)
    values (r.workspace_id, r.person_id, left(coalesce(nullif(btrim(r.title), ''), 'Visit'), 200),
      case r.status when 'completed' then 'done' when 'cancelled' then 'cancelled' else 'scheduled' end,
      r.created_by)
    returning id into v_job;
    update app.appointments set job_id = v_job where id = r.id;
  end loop;
end;
$$;

alter publication powersync add table app.jobs;
grant select on app.jobs to hfos_sync;
