-- =============================================================================
-- Video meetings, step 5: transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §8).
--        When a recorded Zoom call ends, Zoom tells the worker; it downloads
--        the transcript and keeps it here, on the appointment, as plain text.
--        Whoever can see the appointment can read it; it goes when the
--        appointment is deleted for good. The raw recording is never kept.
-- =============================================================================

create table app.appointment_transcripts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  provider text not null check (provider in ('zoom')),
  -- The provider's id for the transcript file, so a repeated webhook keeps one copy.
  external_id text not null check (length(external_id) between 1 and 200),
  body text not null check (length(body) <= 2000000),
  created_at timestamptz not null default now(),
  unique (appointment_id, external_id)
);
create index appointment_transcripts_workspace_idx on app.appointment_transcripts (workspace_id, created_at desc);

create or replace function private.check_appointment_transcript_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger appointment_transcripts_check_refs before insert or update on app.appointment_transcripts
  for each row execute function private.check_appointment_transcript_refs();

alter table app.appointment_transcripts enable row level security;
-- Whoever can see the appointment (its own privacy rules apply through the subquery) can read what was said.
create policy appointment_transcripts_select on app.appointment_transcripts for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and appointment_id in (select a.id from app.appointments a));
create policy appointment_transcripts_service_all on app.appointment_transcripts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.appointment_transcripts to authenticated;
grant select, insert, update, delete on app.appointment_transcripts to service_actor;
revoke all on app.appointment_transcripts from anon;

-- ---------- Zoom's webhook names a meeting, not a business ----------
create index appointments_meeting_id_idx on app.appointments ((location ->> 'meetingId'))
  where location ->> 'meetingId' is not null;

-- The appointment a Zoom meeting was made for (the tenant isn't known yet when the webhook arrives).
create or replace function private.appointment_by_meeting_id(p_meeting_id text)
returns table (appointment_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id
  from app.appointments a join app.workspaces w on w.id = a.workspace_id
  where a.location ->> 'meetingId' = p_meeting_id and a.location ->> 'video' = 'zoom'
  limit 1
$$;

revoke all on function private.check_appointment_transcript_refs(), private.appointment_by_meeting_id(text) from public;
grant execute on function private.check_appointment_transcript_refs() to authenticated, service_actor;
grant execute on function private.appointment_by_meeting_id(text) to service_actor;
