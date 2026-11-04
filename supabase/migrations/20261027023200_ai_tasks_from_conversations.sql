-- =============================================================================
-- The AI makes tasks from what the team says (owner, 4 Nov: "it should just create the task").
--
--        - A phone call on the business number that someone on the team answered or placed gets the review a
--          video call gets, once its words are in: a summary on the call's own line on the customer's timeline
--          (kept here, on the call), the tasks the team agreed to, a follow-up email and a record change. The
--          summary is the call's; what it suggests is a row of app.call_suggestions, as an appointment's and a
--          video call's are, with the call in the new call_id (and no transcript row: a phone call keeps its
--          words on itself).
--        - Every review now makes its tasks at once, while Settings → Automations' "Add tasks from what you say"
--          is on (it is, unless a business turns it off): the row is written already approved, with the task it
--          made. A follow-up email and a record change still wait for a person.
--        - The texts, emails and chats someone on the team writes are read the same way, a couple of minutes
--          after they write (a burst is one read). app.conversation_task_reads keeps how far each conversation
--          was read, so nothing is read twice; only the worker reads and writes it.
--
-- Only adds: a column, a nullable column made so, a widened check and policy, and a table. The running code
-- writes and reads the same rows it did.
-- =============================================================================

-- ---------- A phone call's summary ----------
alter table app.calls
  add column summary text check (summary is null or length(summary) <= 4000);
comment on column app.calls.summary is
  'What the AI made of the call once its words were in (call_suggestion.record), also the body of its timeline line.';

-- ---------- What a phone call's review made ----------
alter table app.call_suggestions
  alter column transcript_id drop not null,
  add column call_id uuid references app.calls (id) on delete cascade,
  drop constraint call_suggestions_for_check,
  add constraint call_suggestions_for_check check (num_nonnulls(appointment_id, video_call_id, call_id) = 1),
  -- An appointment's or a video call's review is of one of its transcripts; a phone call's, of the call itself.
  add constraint call_suggestions_transcript_check check ((call_id is null) = (transcript_id is not null));
create index call_suggestions_phone_call_idx on app.call_suggestions (call_id, created_at)
  where call_id is not null;

comment on column app.call_suggestions.call_id is
  'A phone call on the business number, which keeps its own words (so transcript_id is null).';

create or replace function private.check_call_suggestion_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.call_id is not null then
    if not exists (select 1 from app.calls k where k.id = new.call_id and k.workspace_id = new.workspace_id) then
      raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif not exists (select 1 from app.appointment_transcripts t
                    where t.id = new.transcript_id and t.workspace_id = new.workspace_id
                      and t.appointment_id is not distinct from new.appointment_id
                      and t.video_call_id is not distinct from new.video_call_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
drop trigger call_suggestions_check_refs on app.call_suggestions;
create trigger call_suggestions_check_refs
  before insert or update of appointment_id, video_call_id, call_id, transcript_id, workspace_id
  on app.call_suggestions for each row execute function private.check_call_suggestion_refs();
drop trigger call_suggestions_immutable on app.call_suggestions;
create trigger call_suggestions_immutable before update on app.call_suggestions for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'video_call_id',
    'call_id', 'transcript_id', 'kind');

-- Whoever can see the appointment, the video call or the phone call (a narrowed inbox's, only its people) sees what
-- the AI made of it.
drop policy call_suggestions_select on app.call_suggestions;
create policy call_suggestions_select on app.call_suggestions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (appointment_id in (select a.id from app.appointments a)
              or video_call_id in (select c.id from app.video_calls c)
              or call_id in (select k.id from app.calls k)));

-- ---------- How far the team's own messages were read for tasks ----------
create table app.conversation_task_reads (
  conversation_id uuid primary key references app.conversations (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Every message someone on the team wrote up to this moment has been read.
  read_through timestamptz not null,
  -- The tasks the reads made, all told.
  tasks integer not null default 0 check (tasks >= 0),
  updated_at timestamptz not null default now()
);
create index conversation_task_reads_workspace_idx on app.conversation_task_reads (workspace_id);

create or replace function private.check_conversation_task_read_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.conversations c
                 where c.id = new.conversation_id and c.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger conversation_task_reads_check_refs
  before insert or update of conversation_id, workspace_id
  on app.conversation_task_reads for each row execute function private.check_conversation_task_read_refs();

alter table app.conversation_task_reads enable row level security;
-- Only the worker reads and writes them.
create policy conversation_task_reads_service_all on app.conversation_task_reads for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert, update, delete on app.conversation_task_reads to service_actor;
revoke all on app.conversation_task_reads from anon, authenticated;

revoke all on function private.check_conversation_task_read_refs() from public;
grant execute on function private.check_conversation_task_read_refs() to authenticated, service_actor;
