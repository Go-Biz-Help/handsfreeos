-- =============================================================================
-- Webinars, part 1: the webinar room
-- (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's answers of 29 October 2026).
--
--        A HandsFreeOS call for a session (an appointment of kind `session`,
--        where each person books a seat and gets their own Join link) is a
--        webinar: up to 500 people, the presenter big, attendees watching.
--
--        - **The format** is set when the call is made and never changes:
--          `webinar` for a session's call, `meeting` for everything else.
--        - **Attendees' cameras** (the owner's 4): off, on and seen only by
--          the team, or on and seen by everyone. The team changes it during
--          the webinar.
--        - **On stage**: an attendee the team brings on stage may use their
--          microphone and camera until they're sent back.
--        - **The link anyone can use** (5c): `/live/<key>` books a seat on the
--          session from a door form and, while the webinar is open, goes
--          straight in. The key isn't secret: it's a public link.
--        - **Starting now** (24): when the "starting now" message went to the
--          people booked who weren't in yet, so it goes once.
--
-- Only widens: new columns with defaults, two column grants, a lookup for the
-- worker, and calls already made for sessions marked as webinars. The one
-- narrowing: a call someone starts from a screen is always a plain meeting.
-- =============================================================================

alter table app.video_calls
  add column format text not null default 'meeting' check (format in ('meeting', 'webinar')),
  add column attendee_video text not null default 'off' check (attendee_video in ('off', 'team', 'everyone')),
  add column door_key text check (door_key is null or door_key ~ '^[0-9A-Za-z]{24}$'),
  add column starting_now_at timestamptz;

comment on column app.video_calls.format is
  'meeting: everyone talks and is on camera, up to 10. webinar (a session''s call): the team presents to up to 500 who watch. Set when the call is made.';
comment on column app.video_calls.attendee_video is
  'A webinar: whether attendees may turn their cameras on (off), and who sees them: only the team (team) or everyone (everyone).';
comment on column app.video_calls.door_key is
  'A webinar: the key in its link anyone can use (/live/<key>), which books a seat from a door form. Public, not secret.';
comment on column app.video_calls.starting_now_at is
  'A webinar: when the "starting now" message went to the people booked who weren''t in yet.';

create unique index video_calls_door_key on app.video_calls (door_key) where door_key is not null;
create index video_calls_starting_idx on app.video_calls (workspace_id)
  where format = 'webinar' and starting_now_at is null;

alter table app.video_call_people
  add column on_stage boolean not null default false;

comment on column app.video_call_people.on_stage is
  'A webinar: an attendee the team brought on stage, who may use their microphone and camera until sent back.';

-- The team changes attendees' cameras and who is on stage, through the commands, as the person.
grant update (attendee_video) on app.video_calls to authenticated;
grant update (on_stage) on app.video_call_people to authenticated;

-- Calls already made for sessions are webinars, each with its link anyone can use.
update app.video_calls c
set format = 'webinar',
    door_key = substr(md5(c.id::text || clock_timestamp()::text || random()::text), 1, 24)
from app.appointments a
where a.id = c.appointment_id and a.kind = 'session' and c.format = 'meeting';

-- ---------- the worker finds a webinar from its link anyone can use ----------
create or replace function private.video_call_by_door(p_key text)
returns table (call_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id
  from app.video_calls c join app.workspaces w on w.id = c.workspace_id
  where c.door_key = p_key and c.format = 'webinar' and w.deletion_requested_at is null
$$;
revoke all on function private.video_call_by_door(text) from public;
grant execute on function private.video_call_by_door(text) to service_actor;

-- ---------- the "starting now" sweep ----------
-- Webinars whose session started in the last 15 minutes, in a business with calls on, not yet told. The worker
-- sends each person booked who isn't in the call their own Join link, then marks the call.
create or replace function private.webinars_starting(p_limit integer)
returns table (call_id uuid, appointment_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, a.id, c.workspace_id, w.organization_id
  from app.video_calls c
    join app.appointments a on a.id = c.appointment_id
    join app.workspaces w on w.id = c.workspace_id
  where c.format = 'webinar'
    and c.starting_now_at is null
    and w.video_calls
    and w.deletion_requested_at is null
    and a.status = 'scheduled'
    and a.bin_item_id is null
    and a.starts_at <= now()
    and a.starts_at > now() - interval '15 minutes'
  order by a.starts_at
  limit greatest(1, least(p_limit, 200))
$$;
revoke all on function private.webinars_starting(integer) from public;
grant execute on function private.webinars_starting(integer) to service_actor;

-- ---------- a call someone starts from a screen is a meeting ----------
-- Webinars are made by the system for a session, never by a person's insert: the same check as before, plus the
-- new columns at their defaults.
drop policy video_calls_insert on app.video_calls;
create policy video_calls_insert on app.video_calls for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write')
    and appointment_id is null
    and person_id in (select p.id from app.people p)
    and (conversation_id is null or conversation_id in (select c.id from app.conversations c))
    and host_user_id = (select auth.uid())
    and state = 'open' and room_sid is null and started_at is null and ended_at is null
    and seconds_billed = 0 and activity_id is null
    and format = 'meeting' and attendee_video = 'off' and door_key is null and starting_now_at is null);
