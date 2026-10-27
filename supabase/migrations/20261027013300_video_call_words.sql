-- =============================================================================
-- HandsFreeOS's own video calls, part 2: the AI hears the call
-- (docs/video-calls.md; the owner's answers of 27 October 2026, 8a to 11a).
--
--        The worker's listener joins each live call unseen while the call's
--        AI notes are on, and hears each person's microphone on its own, so
--        every line knows who said it. What it hears comes here a few lines
--        at a time, so a listener that restarts in the middle of a call (a
--        deploy) loses next to nothing. When the stretch of the call is over
--        its lines become the appointment's transcript, which the AI's notes
--        and suggestions start from exactly as with Zoom and Google Meet, and
--        the lines go: one transcript, kept once.
--
--        - **Heard lines**: who said it (their row in the call), the name
--          the call showed and their side, the words, and when.
--        - **AI notes off for one call** is the team's to turn (appointments
--          write): the listener leaves, and what it heard of the call so far
--          is forgotten.
--        - **Transcripts** can come from HandsFreeOS video calls too.
--
-- Only widens: a new table, one more column the team may update, one more
-- transcript provider, and a function the listener asks which calls to hear.
-- =============================================================================

alter table app.appointment_transcripts drop constraint appointment_transcripts_provider_check,
  add constraint appointment_transcripts_provider_check
    check (provider in ('zoom', 'google_meet', 'handsfree'));

-- ---------- what the listener heard ----------
create table app.video_call_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  video_call_id uuid not null,
  -- Who said it. Deleting a customer takes their part of the call, their words included.
  person_row_id uuid not null references app.video_call_people (id) on delete cascade,
  -- The team's side or the customer's (anyone let in counts as the customer's), for the transcript and the coach.
  side text not null check (side in ('team', 'customer')),
  -- The name the call showed for them when they said it.
  name text not null check (length(name) between 1 and 120),
  body text not null check (length(body) between 1 and 4000),
  -- Two letters ('en', 'es'), when the speech service said.
  language text check (language is null or language ~ '^[a-z]{2}$'),
  said_at timestamptz not null,
  -- The listener's own name for the line, so a batch sent twice keeps one copy.
  line_key text not null check (length(line_key) between 1 and 100),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, video_call_id) references app.video_calls (workspace_id, id) on delete cascade,
  unique (video_call_id, line_key)
);
create index video_call_lines_call_idx on app.video_call_lines (video_call_id, said_at);
create index video_call_lines_workspace_idx on app.video_call_lines (workspace_id);
create index video_call_lines_person_idx on app.video_call_lines (person_row_id);

comment on table app.video_call_lines is
  'What the AI''s listener heard in a HandsFreeOS video call, until the stretch is over and it becomes the appointment''s transcript.';

create or replace function private.check_video_call_line_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from app.video_call_people p
    where p.id = new.person_row_id and p.video_call_id = new.video_call_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger video_call_lines_check_refs before insert or update on app.video_call_lines
  for each row execute function private.check_video_call_line_refs();

-- Whoever can see the call (and the person who said it) can read what was said; only the worker writes it, and the
-- team forgets it by turning the call's AI notes off.
alter table app.video_call_lines enable row level security;

create policy video_call_lines_select on app.video_call_lines for select to authenticated
  using (video_call_id in (select c.id from app.video_calls c)
    and person_row_id in (select p.id from app.video_call_people p));
create policy video_call_lines_delete on app.video_call_lines for delete to authenticated
  using (private.has_permission(workspace_id, 'appointments.write')
    and video_call_id in (select c.id from app.video_calls c));
create policy video_call_lines_service_all on app.video_call_lines for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, delete on app.video_call_lines to authenticated;
grant select, insert, update, delete on app.video_call_lines to service_actor;
revoke all on app.video_call_lines from anon;

-- ---------- AI notes on or off for one call ----------
grant update (ai_notes) on app.video_calls to authenticated;

-- ---------- the calls the listener hears ----------
-- Live, with their AI notes on, in a business that has calls on: the listener asks every few seconds, across
-- businesses, so it can join a call as it starts and leave one whose notes were turned off. Newest first, so a call
-- that just started is looked at before one LiveKit never said had closed.
create or replace function private.video_calls_to_hear()
returns table (video_call_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id
  from app.video_calls c join app.workspaces w on w.id = c.workspace_id
  where c.state = 'live' and c.ai_notes and w.video_calls and w.deletion_requested_at is null
  order by c.updated_at desc
  limit 500
$$;

revoke all on function private.check_video_call_line_refs(), private.video_calls_to_hear() from public;
grant execute on function private.check_video_call_line_refs() to authenticated, service_actor;
grant execute on function private.video_calls_to_hear() to service_actor;
