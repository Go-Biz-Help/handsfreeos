-- =============================================================================
-- Video meetings, step 6: what the AI makes of a call (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §9).
--        When a transcript arrives, the worker asks the AI for a summary
--        (written to the customer's timeline as a note, on its own) and for
--        suggestions: tasks, and a follow-up message to the customer. The
--        suggestions wait here until a person approves (the command runs as
--        them) or dismisses them. They go with the appointment.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'meetings';

-- The AI's summary of the call, kept with its transcript (also written to the customer's timeline as a note).
alter table app.appointment_transcripts
  add column summary text check (summary is null or length(summary) <= 4000);

create table app.call_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  appointment_id uuid not null references app.appointments (id) on delete cascade,
  transcript_id uuid not null references app.appointment_transcripts (id) on delete cascade,
  kind text not null check (kind in ('task', 'follow_up')),
  -- What would run: a task's title, notes and due date, or the message's subject and body. Shown, editable.
  preview jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'dismissed')),
  -- What approving made (the task, the message's conversation), for the link back.
  result jsonb,
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index call_suggestions_appointment_idx on app.call_suggestions (appointment_id, created_at);
create index call_suggestions_pending_idx on app.call_suggestions (workspace_id, created_at) where status = 'pending';

create or replace function private.check_call_suggestion_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.appointment_transcripts t
                 where t.id = new.transcript_id and t.appointment_id = new.appointment_id
                   and t.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger call_suggestions_check_refs before insert or update of appointment_id, transcript_id, workspace_id
  on app.call_suggestions for each row execute function private.check_call_suggestion_refs();
create trigger call_suggestions_immutable before update on app.call_suggestions for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'transcript_id', 'kind');

alter table app.call_suggestions enable row level security;
-- Whoever can see the appointment sees what the AI suggested about it.
create policy call_suggestions_select on app.call_suggestions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and appointment_id in (select a.id from app.appointments a));
-- Deciding is for people who can change appointments; the command claims a pending row once.
create policy call_suggestions_update on app.call_suggestions for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write') and status = 'pending')
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy call_suggestions_service_all on app.call_suggestions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.call_suggestions to authenticated;
grant update (status, preview, result, decided_by, decided_at) on app.call_suggestions to authenticated;
grant select, insert, update, delete on app.call_suggestions to service_actor;
revoke all on app.call_suggestions from anon;

revoke all on function private.check_call_suggestion_refs() from public;
grant execute on function private.check_call_suggestion_refs() to authenticated, service_actor;
