-- =============================================================================
-- Hearing a Zoom meeting as it happens (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, round three).
--
--        Phone calls are heard live since round one (worker telephony/live.ts).
--        A Zoom meeting is heard through Zoom's Realtime Media Streams: the
--        person opens HandsFreeOS in Zoom's Apps panel during a meeting, which
--        asks Zoom to start the stream. Zoom then tells the worker
--        (`meeting.rtms_started` on /webhooks/zoom) with only the meeting's id,
--        so first the person says which meeting is theirs, here: a **live
--        meeting** is that claim, by the person, in one business, about one
--        Zoom meeting, with the customer it's with when HandsFreeOS knows.
--
--        The worker takes a waiting claim for the meeting whose person's own
--        connected Zoom account (app.meeting_connections) started the stream,
--        marks it live, hands the words to the add-ons that listen
--        (`liveCalls` in a manifest), and marks it ended when the stream does.
--        Nothing of the meeting is kept here: what was said is the add-on's.
-- =============================================================================

create table app.live_meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The person in the meeting who asked HandsFreeOS to listen.
  user_id uuid not null references app.users (id) on delete cascade,
  provider text not null default 'zoom' check (provider in ('zoom')),
  -- Zoom's id for this meeting instance (`meetingUUID`), which its webhook names.
  meeting_uuid text not null check (length(meeting_uuid) between 1 and 200),
  -- The number people join with, which finds the appointment it was made for.
  meeting_number text check (meeting_number is null or meeting_number ~ '^[0-9]{6,20}$'),
  appointment_id uuid references app.appointments (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  -- The person's name in the meeting, so their own words are told from the customer's.
  screen_name text check (screen_name is null or length(screen_name) <= 200),
  state text not null default 'waiting' check (state in ('waiting', 'live', 'ended')),
  -- Zoom's id for the stream, once it started.
  stream_id text check (stream_id is null or length(stream_id) <= 200),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((state = 'waiting' and stream_id is null and started_at is null and ended_at is null)
      or (state = 'live' and stream_id is not null and started_at is not null and ended_at is null)
      or (state = 'ended' and ended_at is not null))
);
-- One claim at a time per person per meeting: asking again finds it.
create unique index live_meetings_one_open on app.live_meetings (workspace_id, user_id, provider, meeting_uuid)
  where state in ('waiting', 'live');
create index live_meetings_meeting_idx on app.live_meetings (provider, meeting_uuid) where state in ('waiting', 'live');
create index live_meetings_user_idx on app.live_meetings (user_id);
create index live_meetings_person_idx on app.live_meetings (person_id) where person_id is not null;
create index live_meetings_appointment_idx on app.live_meetings (appointment_id) where appointment_id is not null;
create trigger live_meetings_updated_at before update on app.live_meetings
  for each row execute function private.set_updated_at();
create trigger live_meetings_immutable before update on app.live_meetings
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'provider', 'meeting_uuid');

create or replace function private.check_live_meeting_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false)
     or (new.person_id is not null and not exists (
           select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.appointment_id is not null and not exists (
           select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger live_meetings_check_refs before insert or update on app.live_meetings
  for each row execute function private.check_live_meeting_refs();

-- People make and change their own claim while it waits, and may end it; the stream is the worker's.
create or replace function private.guard_live_meeting_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.state <> 'waiting' and not (old.state = 'live' and new.state = 'ended') then
    raise exception 'Only a waiting claim on a meeting can change' using errcode = '42501', detail = 'live_meeting_state_transition';
  end if;
  if new.state not in ('waiting', 'ended') or new.stream_id is distinct from old.stream_id
     or new.started_at is distinct from old.started_at then
    raise exception 'The stream is the worker''s' using errcode = '42501', detail = 'live_meeting_state_transition';
  end if;
  if new.state = 'ended' and old.state <> 'ended' then
    new.ended_at := now();
  end if;
  return new;
end $$;
create trigger live_meetings_update_guard before update on app.live_meetings
  for each row execute function private.guard_live_meeting_update();

-- ---------- RLS ----------
alter table app.live_meetings enable row level security;

create policy live_meetings_select on app.live_meetings for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid()));
create policy live_meetings_insert on app.live_meetings for insert to authenticated
  with check (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid())
    and state = 'waiting' and stream_id is null and started_at is null and ended_at is null);
create policy live_meetings_update on app.live_meetings for update to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy live_meetings_service_all on app.live_meetings for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.live_meetings to authenticated;
grant update (meeting_number, appointment_id, person_id, screen_name, state) on app.live_meetings to authenticated;
grant select, insert, update, delete on app.live_meetings to service_actor;
revoke all on app.live_meetings from anon;

-- ---------- the webhook finds the claim ----------
-- Zoom names only the meeting: the waiting claims on it, newest first, each with the Zoom user its person connected
-- in that business, so the worker takes the one whose Zoom account started the stream.
create or replace function private.live_meetings_waiting(p_provider text, p_meeting_uuid text)
returns table (live_meeting_id uuid, workspace_id uuid, organization_id uuid, user_id uuid,
  external_user_id text, person_id uuid, screen_name text)
language sql stable security definer set search_path = '' as $$
  select lm.id, lm.workspace_id, w.organization_id, lm.user_id,
    (select c.external_user_id from app.meeting_connections c
      where c.workspace_id = lm.workspace_id and c.user_id = lm.user_id and c.provider::text = lm.provider
        and c.status = 'active'
      order by c.connected_at desc nulls last limit 1),
    lm.person_id, lm.screen_name
  from app.live_meetings lm join app.workspaces w on w.id = lm.workspace_id
  where lm.provider = p_provider and lm.meeting_uuid = p_meeting_uuid and lm.state = 'waiting'
    and lm.created_at > now() - interval '1 hour'
  order by lm.created_at desc
  limit 20
$$;
revoke all on function private.live_meetings_waiting(text, text) from public;
grant execute on function private.live_meetings_waiting(text, text) to service_actor;
