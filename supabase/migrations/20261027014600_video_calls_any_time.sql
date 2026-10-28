-- =============================================================================
-- HandsFreeOS's own video calls, part 5: calls any time
-- (docs/video-calls.md; the owner's answers of 27 October 2026, pick 5c).
--
--        **Video call** on a customer's page or in a conversation, and
--        **Switch to video** during a phone call, make a call with that
--        customer, send them their own link (a text, an email, or the
--        conversation's own channel) and open the call for whoever pressed
--        it. A call that isn't for an appointment is its own line on the
--        customer's timeline, with the same transcript, summary and After
--        the call as an appointment's.
--
--        - **The customer's own link** is `/j/<key>`: a random key only its
--          hash is kept of. On it they go straight in once someone from the
--          team is there, as on an appointment's Join link.
--        - **The team makes the call**: one with a customer they can see,
--          hosted by whoever made it, with appointments write.
--        - **Their own line on the timeline**, once the call is over.
--        - **Transcripts and After the call** belong to an appointment or to
--          one of these calls.
--
-- Only widens: new columns, a relaxed check, an insert policy, two columns
-- made optional beside a new one that takes their place, and policies that
-- see one more way in.
-- =============================================================================

-- ---------- a call with a customer, made by the team ----------
alter table app.video_calls
  add column link_key_hash text check (link_key_hash is null or length(link_key_hash) = 64),
  add column activity_id uuid references app.activities (id) on delete set null;

comment on column app.video_calls.link_key_hash is
  'A call that isn''t for an appointment: the hash of the key in the customer''s own link (/j/<key>), which is never kept.';
comment on column app.video_calls.activity_id is
  'A call that isn''t for an appointment: its own line on the customer''s timeline, written once the call is over.';

create unique index video_calls_link_key on app.video_calls (link_key_hash) where link_key_hash is not null;
create index video_calls_activity_idx on app.video_calls (activity_id) where activity_id is not null;

-- Whoever can see the customer and holds appointments write makes one, hosted by them and opening with nobody in it.
create policy video_calls_insert on app.video_calls for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write')
    and appointment_id is null
    and person_id in (select p.id from app.people p)
    and (conversation_id is null or conversation_id in (select c.id from app.conversations c))
    and host_user_id = (select auth.uid())
    and state = 'open' and room_sid is null and started_at is null and ended_at is null
    and seconds_billed = 0 and activity_id is null);
grant insert on app.video_calls to authenticated;

-- The worker finds a customer's call from the key in their link.
create or replace function private.video_call_by_link(p_hash text)
returns table (call_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id
  from app.video_calls c join app.workspaces w on w.id = c.workspace_id
  where c.link_key_hash = p_hash and w.deletion_requested_at is null
$$;
revoke all on function private.video_call_by_link(text) from public;
grant execute on function private.video_call_by_link(text) to service_actor;

-- ---------- the customer on their own link ----------
-- A call's customer is a booking's attendee, or the customer a call that isn't for an appointment is with.
alter table app.video_call_people drop constraint video_call_people_check1,
  add constraint video_call_people_customer_check
    check (kind <> 'customer' or attendee_id is not null or person_id is not null);
create unique index video_call_people_one_person on app.video_call_people (video_call_id, person_id)
  where kind = 'customer' and attendee_id is null;

create or replace function private.check_video_call_person_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.user_id is not null and not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false))
     or (new.attendee_id is not null and not exists (
        select 1 from app.appointment_attendees aa join app.video_calls c on c.appointment_id = aa.appointment_id
        where aa.id = new.attendee_id and aa.workspace_id = new.workspace_id and c.id = new.video_call_id))
     or (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     -- A customer without a booking is the one the call is with.
     or (new.kind = 'customer' and new.attendee_id is null and not exists (
        select 1 from app.video_calls c where c.id = new.video_call_id and c.person_id = new.person_id))
     or (new.admitted_by is not null
         and not coalesce(private.workspace_has_user(new.workspace_id, new.admitted_by), false)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- ---------- transcripts: an appointment's, or a call's ----------
alter table app.appointment_transcripts
  alter column appointment_id drop not null,
  add column video_call_id uuid,
  add constraint appointment_transcripts_call_fkey foreign key (workspace_id, video_call_id)
    references app.video_calls (workspace_id, id) on delete cascade,
  add constraint appointment_transcripts_for_check check (num_nonnulls(appointment_id, video_call_id) = 1);
create unique index appointment_transcripts_call_stretch on app.appointment_transcripts (video_call_id, external_id)
  where video_call_id is not null;

comment on column app.appointment_transcripts.video_call_id is
  'A call that isn''t for an appointment, which keeps its transcript here instead (part 5).';

create or replace function private.check_appointment_transcript_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.appointment_id is not null
     and not exists (select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- Whoever can see the appointment, or the call, can read what was said.
drop policy appointment_transcripts_select on app.appointment_transcripts;
create policy appointment_transcripts_select on app.appointment_transcripts for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (appointment_id in (select a.id from app.appointments a)
              or video_call_id in (select c.id from app.video_calls c)));

-- ---------- After the call: an appointment's, or a call's ----------
alter table app.call_suggestions
  alter column appointment_id drop not null,
  add column video_call_id uuid,
  add constraint call_suggestions_call_fkey foreign key (workspace_id, video_call_id)
    references app.video_calls (workspace_id, id) on delete cascade,
  add constraint call_suggestions_for_check check (num_nonnulls(appointment_id, video_call_id) = 1);
create index call_suggestions_call_idx on app.call_suggestions (video_call_id, created_at)
  where video_call_id is not null;

create or replace function private.check_call_suggestion_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.appointment_transcripts t
                 where t.id = new.transcript_id and t.workspace_id = new.workspace_id
                   and t.appointment_id is not distinct from new.appointment_id
                   and t.video_call_id is not distinct from new.video_call_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
drop trigger call_suggestions_check_refs on app.call_suggestions;
create trigger call_suggestions_check_refs
  before insert or update of appointment_id, video_call_id, transcript_id, workspace_id
  on app.call_suggestions for each row execute function private.check_call_suggestion_refs();
drop trigger call_suggestions_immutable on app.call_suggestions;
create trigger call_suggestions_immutable before update on app.call_suggestions for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'video_call_id',
    'transcript_id', 'kind');

-- Whoever can see the appointment, or the call, sees what the AI suggested about it.
drop policy call_suggestions_select on app.call_suggestions;
create policy call_suggestions_select on app.call_suggestions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (appointment_id in (select a.id from app.appointments a)
              or video_call_id in (select c.id from app.video_calls c)));
