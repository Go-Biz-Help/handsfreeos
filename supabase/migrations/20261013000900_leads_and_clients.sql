-- =============================================================================
-- Leads and clients.
--
--        Contacts filters between leads and clients, on the web and on the
--        phone. A client is someone the business is working for, has worked
--        for, or has been paid by; everyone else is a lead. Any one of these
--        makes a person a client:
--
--        - a lead of theirs marked won;
--        - a job for them underway or done (a job that is only booked may
--          still be a quote visit);
--        - a visit they came to;
--        - a maintenance plan they are on;
--        - money they have paid on a bill.
--
--        A company is a client when a lead of its own was won, or when one of
--        its people is a client.
--
--        The phone can't work this out from its own copy: finished jobs, visits
--        more than 90 days old and bills paid more than a year ago never reach
--        it. So the database keeps the answer, one row in app.client_marks per
--        client, and both the web and the phone read it. Triggers on the tables
--        the rule reads keep it current, and nobody writes it by hand. It is a
--        table of its own rather than a column on people and companies, so
--        marking someone never stamps their record as changed, never meets the
--        guard on an archived record, and never fires a record's own triggers.
--
--        Everyone who can open the business sees the same answer: a member who
--        can't see its bills still sees who is a client.
--
--        When rows go (a delete, or a record moved off someone) a mark may only
--        be taken away, never added, and a mark is only ever added for a
--        record whose business is still there: a business being deleted takes
--        its marks with it, and no new one appears mid-delete pointing at it.
-- =============================================================================

create table app.client_marks (
  -- The person's or the company's own id, so the phone keys a mark by the record it marks.
  id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid unique references app.people (id) on delete cascade,
  company_id uuid unique references app.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (num_nonnulls(person_id, company_id) = 1 and id = coalesce(person_id, company_id))
);
create index client_marks_workspace_idx on app.client_marks (workspace_id);

alter table app.client_marks enable row level security;
create policy client_marks_select on app.client_marks for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy client_marks_service_select on app.client_marks for select to service_actor
  using (workspace_id = private.system_scope_workspace());
grant select on app.client_marks to authenticated, service_actor;
revoke all on app.client_marks from anon;

-- ---------- the rule ----------

create or replace function private.person_is_client(p_person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    exists (select 1 from app.leads l
      where l.person_id = p_person and l.status = 'won' and l.archived_at is null)
    or exists (select 1 from app.jobs j
      where j.person_id = p_person and j.status in ('on_the_way', 'in_progress', 'waiting_on_parts', 'done'))
    or exists (select 1 from app.appointment_attendees t join app.appointments a on a.id = t.appointment_id
      where t.person_id = p_person and (t.status = 'attended' or (t.status = 'booked' and a.status = 'completed')))
    or exists (select 1 from app.subscriptions s
      where s.person_id = p_person and s.status in ('active', 'past_due', 'paused', 'unmanaged'))
    or exists (select 1 from app.invoices i
      where i.person_id = p_person and i.status <> 'void' and i.amount_paid_cents > 0);
$$;
revoke execute on function private.person_is_client(uuid) from public;

-- A company's mark reads its people's marks, so a person's is always settled first.
create or replace function private.refresh_company_mark(p_company uuid, p_may_add boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_client boolean;
begin
  if p_company is null then
    return;
  end if;
  -- Joined to its business, so a company whose business is being deleted reads as gone.
  select c.workspace_id into v_ws from app.companies c join app.workspaces w on w.id = c.workspace_id
  where c.id = p_company;
  v_client := found and (
    exists (select 1 from app.leads l
      where l.company_id = p_company and l.status = 'won' and l.archived_at is null)
    or exists (select 1 from app.client_marks m join app.people p on p.id = m.person_id
      where p.company_id = p_company));
  if v_client and p_may_add then
    insert into app.client_marks (id, workspace_id, company_id) values (p_company, v_ws, p_company)
    on conflict (id) do nothing;
  elsif not v_client then
    delete from app.client_marks where id = p_company;
  end if;
end;
$$;
revoke execute on function private.refresh_company_mark(uuid, boolean) from public;

create or replace function private.refresh_person_mark(p_person uuid, p_may_add boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_company uuid;
  v_client boolean;
begin
  if p_person is null then
    return;
  end if;
  select p.workspace_id, p.company_id into v_ws, v_company from app.people p
  join app.workspaces w on w.id = p.workspace_id
  where p.id = p_person;
  v_client := found and private.person_is_client(p_person);
  if v_client and p_may_add then
    insert into app.client_marks (id, workspace_id, person_id) values (p_person, v_ws, p_person)
    on conflict (id) do nothing;
  elsif not v_client then
    delete from app.client_marks where id = p_person;
  end if;
  perform private.refresh_company_mark(v_company, p_may_add);
end;
$$;
revoke execute on function private.refresh_person_mark(uuid, boolean) from public;

-- ---------- what moves a mark ----------
-- Every update trigger here compares old and new in its WHEN rather than naming columns: a lead's status is set by
-- a trigger of its own when it changes stage, and a trigger that names its columns never sees a change like that.

-- Jobs, visits' seats, plans and bills: each names the person it is for.
create or replace function private.client_marks_follow_person()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    perform private.refresh_person_mark(new.person_id, true);
  end if;
  -- Whoever it was for before can only have lost something.
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.person_id is distinct from new.person_id) then
    perform private.refresh_person_mark(old.person_id, false);
  end if;
  return null;
end;
$$;
revoke execute on function private.client_marks_follow_person() from public;

create trigger jobs_client_marks after insert or delete on app.jobs
  for each row execute function private.client_marks_follow_person();
create trigger jobs_client_marks_update after update on app.jobs
  for each row when (old.person_id is distinct from new.person_id or old.status is distinct from new.status)
  execute function private.client_marks_follow_person();

create trigger appointment_attendees_client_marks after insert or delete on app.appointment_attendees
  for each row execute function private.client_marks_follow_person();
create trigger appointment_attendees_client_marks_update after update on app.appointment_attendees
  for each row when (old.person_id is distinct from new.person_id or old.status is distinct from new.status)
  execute function private.client_marks_follow_person();

create trigger subscriptions_client_marks after insert or delete on app.subscriptions
  for each row execute function private.client_marks_follow_person();
create trigger subscriptions_client_marks_update after update on app.subscriptions
  for each row when (old.person_id is distinct from new.person_id or old.status is distinct from new.status)
  execute function private.client_marks_follow_person();

create trigger invoices_client_marks after insert or delete on app.invoices
  for each row execute function private.client_marks_follow_person();
create trigger invoices_client_marks_update after update on app.invoices
  for each row when (old.person_id is distinct from new.person_id or old.status is distinct from new.status
    or old.amount_paid_cents is distinct from new.amount_paid_cents)
  execute function private.client_marks_follow_person();

-- Leads name a person, a company or both.
create or replace function private.client_marks_follow_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    perform private.refresh_person_mark(new.person_id, true);
    perform private.refresh_company_mark(new.company_id, true);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.person_id is distinct from new.person_id) then
    perform private.refresh_person_mark(old.person_id, false);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.company_id is distinct from new.company_id) then
    perform private.refresh_company_mark(old.company_id, false);
  end if;
  return null;
end;
$$;
revoke execute on function private.client_marks_follow_lead() from public;

create trigger leads_client_marks after insert or delete on app.leads
  for each row execute function private.client_marks_follow_lead();
create trigger leads_client_marks_update after update on app.leads
  for each row when (old.person_id is distinct from new.person_id or old.company_id is distinct from new.company_id
    or old.status is distinct from new.status or old.archived_at is distinct from new.archived_at)
  execute function private.client_marks_follow_lead();

-- A visit marked done (or undone) settles every seat on it.
create or replace function private.client_marks_follow_appointment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid;
begin
  for v_person in select distinct t.person_id from app.appointment_attendees t where t.appointment_id = new.id loop
    perform private.refresh_person_mark(v_person, true);
  end loop;
  return null;
end;
$$;
revoke execute on function private.client_marks_follow_appointment() from public;

create trigger appointments_client_marks after update on app.appointments
  for each row when (old.status is distinct from new.status)
  execute function private.client_marks_follow_appointment();

-- A person joining or leaving a company carries their mark with them; one deleted may take the company's.
create or replace function private.client_marks_follow_people()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.refresh_company_mark(old.company_id, false);
  if tg_op = 'UPDATE' then
    perform private.refresh_company_mark(new.company_id, true);
  end if;
  return null;
end;
$$;
revoke execute on function private.client_marks_follow_people() from public;

create trigger people_client_marks after delete on app.people
  for each row execute function private.client_marks_follow_people();
create trigger people_client_marks_update after update on app.people
  for each row when (old.company_id is distinct from new.company_id)
  execute function private.client_marks_follow_people();

-- ---------- every mark as it stands today ----------

insert into app.client_marks (id, workspace_id, person_id)
select p.id, p.workspace_id, p.id from app.people p where private.person_is_client(p.id);

insert into app.client_marks (id, workspace_id, company_id)
select c.id, c.workspace_id, c.id from app.companies c
where exists (select 1 from app.leads l where l.company_id = c.id and l.status = 'won' and l.archived_at is null)
  or exists (select 1 from app.client_marks m join app.people p on p.id = m.person_id where p.company_id = c.id);

-- ---------- the phone ----------

alter publication powersync add table app.client_marks;
grant select on app.client_marks to hfos_sync;
