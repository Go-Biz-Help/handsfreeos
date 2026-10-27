-- =============================================================================
-- HandsFreeOS's own video calls, part 1: the call itself, on the web
-- (docs/video-calls.md; the owner's answers of 27 October 2026).
--
--        A calendar's Online place gets one more choice, HandsFreeOS video
--        call (`handsfree`): nothing to connect, the call is made with the
--        appointment. LiveKit carries the video; the worker alone holds its
--        keys, hands out the tickets people join with, and hears LiveKit's
--        webhooks for who came and went.
--
--        - **A video call** is one appointment's call (a customer's or a
--          conversation's later, part 5), and whether it's open, live or
--          over. One per appointment.
--        - **Who's in it**: one row per teammate, per customer on their own
--          Join link, and per person who asked to be let in, with when they
--          came and went and how long they were in. A customer on their own
--          link goes straight in once someone from the team is there; anyone
--          else waits to be let in.
--        - **Staff turn it on per business** in /admin
--          (`private.set_video_calls`), for test businesses first.
--        - **One line on the rate card**, `video.minute`: a minute of one
--          person in a call, at 1.5×.
--        - **Attendance**: a customer on a HandsFreeOS call is marked from
--          whether they were really in it, on one-on-one visits too.
--
-- Only widens: new tables, a column nothing reads yet, one more rate card key,
-- one more webhook provider, and the attendance close taking in calls it
-- skipped before.
-- =============================================================================

-- ---------- the switch support turns on ----------
alter table app.workspaces add column video_calls boolean not null default false;

comment on column app.workspaces.video_calls is
  'HandsFreeOS video calls are on for this business: its Online places can make them. Set by support in /admin, test businesses first.';

create or replace function private.guard_video_calls_switch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.video_calls is distinct from old.video_calls then
    raise exception 'Only HandsFreeOS support turns video calls on for a business'
      using errcode = '42501', detail = 'video_calls_switch_is_ours';
  end if;
  return new;
end $$;

create trigger workspaces_video_calls before update on app.workspaces
  for each row execute function private.guard_video_calls_switch();

-- Staff-only, one business at a time, and it says what it was so an accidental repeat is visibly a no-op.
create or replace function private.set_video_calls(p_workspace uuid, p_on boolean)
returns table (was boolean, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was boolean;
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'You cannot turn video calls on or off for a business'
      using errcode = '42501', detail = 'video_calls_switch_is_ours';
  end if;
  select w.video_calls into v_was from app.workspaces w where w.id = p_workspace for update;
  if not found then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  update app.workspaces set video_calls = p_on where id = p_workspace;
  return query select v_was, v_was is distinct from p_on;
end $$;

revoke execute on function private.set_video_calls(uuid, boolean) from public;
grant execute on function private.set_video_calls(uuid, boolean) to authenticated;

-- ---------- the calls ----------
create table app.video_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The appointment it's for. Deleting the appointment for good takes its call.
  appointment_id uuid references app.appointments (id) on delete cascade,
  -- The customer it's with when it isn't for an appointment (part 5).
  person_id uuid references app.people (id) on delete cascade,
  conversation_id uuid references app.conversations (id) on delete set null,
  -- Who the customer waits for ("Dana will be right with you"), and whose phone hears they're waiting.
  host_user_id uuid references app.users (id) on delete set null,
  -- open: nobody has been in yet, or it was ended and can start again. live: someone is in it.
  state text not null default 'open' check (state in ('open', 'live', 'ended')),
  -- The AI's notes on this call (part 2): on unless the host turns them off for it.
  ai_notes boolean not null default true,
  -- LiveKit's id for the room while it's running, which names one stretch of the call on the balance.
  room_sid text check (room_sid is null or length(room_sid) <= 100),
  started_at timestamptz,
  ended_at timestamptz,
  -- Person-seconds already charged, so a call that starts again is charged only for the new stretch.
  seconds_billed integer not null default 0 check (seconds_billed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (appointment_id is not null or person_id is not null)
);
create unique index video_calls_one_per_appointment on app.video_calls (appointment_id)
  where appointment_id is not null;
create index video_calls_workspace_idx on app.video_calls (workspace_id, created_at desc);
create index video_calls_person_idx on app.video_calls (person_id) where person_id is not null;
create index video_calls_conversation_idx on app.video_calls (conversation_id) where conversation_id is not null;
create index video_calls_host_idx on app.video_calls (host_user_id) where host_user_id is not null;
create index video_calls_live_idx on app.video_calls (updated_at) where state = 'live';
create trigger video_calls_updated_at before update on app.video_calls
  for each row execute function private.set_updated_at();
create trigger video_calls_immutable before update on app.video_calls
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'appointment_id', 'person_id');

create or replace function private.check_video_call_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.appointment_id is not null and not exists (
        select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id))
     or (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.conversation_id is not null and not exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
     or (new.host_user_id is not null
         and not coalesce(private.workspace_has_user(new.workspace_id, new.host_user_id), false)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger video_calls_check_refs before insert or update on app.video_calls
  for each row execute function private.check_video_call_refs();

-- A person ends a call for everyone, or starts one again that was ended; what LiveKit says happened is the worker's.
create or replace function private.guard_video_call_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.state is distinct from old.state
     and not (new.state = 'ended' and old.state in ('open', 'live'))
     and not (new.state = 'open' and old.state = 'ended') then
    raise exception 'A call is only ended, or started again, by a person' using errcode = '42501', detail = 'video_call_state_transition';
  end if;
  if new.state = 'ended' and old.state <> 'ended' then
    new.ended_at := now();
  end if;
  return new;
end $$;
create trigger video_calls_update_guard before update on app.video_calls
  for each row execute function private.guard_video_call_update();

-- ---------- who's in them ----------
create table app.video_call_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  video_call_id uuid not null,
  -- team: someone who works here. customer: a customer on their own Join link. guest: anyone let in.
  kind text not null check (kind in ('team', 'customer', 'guest')),
  user_id uuid references app.users (id) on delete cascade,
  attendee_id uuid references app.appointment_attendees (id) on delete cascade,
  -- The customer, so deleting them takes their part in the call.
  person_id uuid references app.people (id) on delete cascade,
  -- The name everyone in the call sees.
  name text not null check (length(name) between 1 and 120),
  -- waiting: asked to come in. admitted: given a ticket. in: in the call. left: was in.
  -- turned_away: asked and was told no. removed: taken out by the team.
  state text not null default 'waiting'
    check (state in ('waiting', 'admitted', 'in', 'left', 'turned_away', 'removed')),
  -- A guest's own key, hashed, so only they can ask whether they've been let in.
  knock_key_hash text check (knock_key_hash is null or length(knock_key_hash) = 64),
  -- When they started waiting, for "waiting 2 min" and one push per wait.
  asked_at timestamptz,
  admitted_at timestamptz,
  admitted_by uuid references app.users (id) on delete set null,
  -- The first time they were in the call, the last time they came in, and when they last left.
  joined_at timestamptz,
  last_joined_at timestamptz,
  left_at timestamptz,
  -- LiveKit's id for the connection they're in the call on now: a second phone or a reload is a new connection that
  -- takes over, and the old one's leaving is then no leaving at all.
  participant_sid text check (participant_sid is null or length(participant_sid) <= 100),
  -- How long they've been in it altogether.
  seconds integer not null default 0 check (seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, video_call_id) references app.video_calls (workspace_id, id) on delete cascade,
  check (kind <> 'team' or user_id is not null),
  check (kind <> 'customer' or attendee_id is not null)
);
create unique index video_call_people_one_teammate on app.video_call_people (video_call_id, user_id)
  where kind = 'team';
create unique index video_call_people_one_customer on app.video_call_people (video_call_id, attendee_id)
  where kind = 'customer';
create index video_call_people_call_idx on app.video_call_people (video_call_id, created_at);
create index video_call_people_workspace_idx on app.video_call_people (workspace_id);
create index video_call_people_user_idx on app.video_call_people (user_id) where user_id is not null;
create index video_call_people_attendee_idx on app.video_call_people (attendee_id) where attendee_id is not null;
create index video_call_people_person_idx on app.video_call_people (person_id) where person_id is not null;
create index video_call_people_admitted_by_idx on app.video_call_people (admitted_by) where admitted_by is not null;
create trigger video_call_people_updated_at before update on app.video_call_people
  for each row execute function private.set_updated_at();
create trigger video_call_people_immutable before update on app.video_call_people
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'video_call_id', 'kind',
    'user_id', 'attendee_id', 'person_id');

create or replace function private.check_video_call_person_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.user_id is not null and not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false))
     or (new.attendee_id is not null and not exists (
        select 1 from app.appointment_attendees aa join app.video_calls c on c.appointment_id = aa.appointment_id
        where aa.id = new.attendee_id and aa.workspace_id = new.workspace_id and c.id = new.video_call_id))
     or (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.admitted_by is not null
         and not coalesce(private.workspace_has_user(new.workspace_id, new.admitted_by), false)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger video_call_people_check_refs before insert or update on app.video_call_people
  for each row execute function private.check_video_call_person_refs();

-- People let someone in, turn them away or take them out, and come in themselves; coming and going is the worker's.
create or replace function private.guard_video_call_person_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.state is distinct from old.state and new.state not in ('admitted', 'turned_away', 'removed') then
    raise exception 'Coming into a call and leaving it is the worker''s' using errcode = '42501', detail = 'video_call_state_transition';
  end if;
  if new.admitted_by is distinct from old.admitted_by and new.admitted_by is distinct from (select auth.uid()) then
    raise exception 'Only you can let someone in as yourself' using errcode = '42501', detail = 'video_call_state_transition';
  end if;
  return new;
end $$;
create trigger video_call_people_update_guard before update on app.video_call_people
  for each row execute function private.guard_video_call_person_update();

-- ---------- RLS ----------
-- Whoever can see the appointment (or the customer) sees its call; changing it takes appointments.write.
alter table app.video_calls enable row level security;

create policy video_calls_select on app.video_calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and (appointment_id is null or appointment_id in (select a.id from app.appointments a))
    and (person_id is null or person_id in (select p.id from app.people p)));
create policy video_calls_update on app.video_calls for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write')
    and (appointment_id is null or appointment_id in (select a.id from app.appointments a))
    and (person_id is null or person_id in (select p.id from app.people p)))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy video_calls_service_all on app.video_calls for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.video_calls to authenticated;
grant update (state, ended_at) on app.video_calls to authenticated;
grant select, insert, update, delete on app.video_calls to service_actor;
revoke all on app.video_calls from anon;

-- A customer in the Deleted bin is hidden from the call's people too, as from everything else.
alter table app.video_call_people enable row level security;

create policy video_call_people_select on app.video_call_people for select to authenticated
  using (video_call_id in (select c.id from app.video_calls c)
    and (person_id is null or person_id in (select p.id from app.people p)));
create policy video_call_people_insert on app.video_call_people for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write')
    and video_call_id in (select c.id from app.video_calls c)
    and kind = 'team' and user_id = (select auth.uid()) and state = 'admitted'
    and (admitted_by is null or admitted_by = (select auth.uid()))
    and attendee_id is null and person_id is null and knock_key_hash is null
    and joined_at is null and last_joined_at is null and left_at is null and participant_sid is null
    and seconds = 0);
create policy video_call_people_update on app.video_call_people for update to authenticated
  using (private.has_permission(workspace_id, 'appointments.write')
    and video_call_id in (select c.id from app.video_calls c)
    and (person_id is null or person_id in (select p.id from app.people p)))
  with check (private.has_permission(workspace_id, 'appointments.write'));
create policy video_call_people_service_all on app.video_call_people for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.video_call_people to authenticated;
grant update (state, name, admitted_at, admitted_by) on app.video_call_people to authenticated;
grant select, insert, update, delete on app.video_call_people to service_actor;
revoke all on app.video_call_people from anon;

-- ---------- the worker finds a call ----------
-- LiveKit names only the room, and a guest's page only the call: the business it belongs to, for the worker's scope.
create or replace function private.video_call_lookup(p_call uuid)
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.workspace_id, w.organization_id
  from app.video_calls c join app.workspaces w on w.id = c.workspace_id
  where c.id = p_call and w.deletion_requested_at is null
$$;
revoke all on function private.video_call_lookup(uuid) from public;
grant execute on function private.video_call_lookup(uuid) to service_actor;

-- ---------- LiveKit's webhooks are stored like everybody else's ----------
-- Who came into a call and left it, and the room closing: kept, then worked through in order with retries.
alter table app.webhook_deliveries
  drop constraint webhook_deliveries_provider_check,
  add constraint webhook_deliveries_provider_check
    check (provider in ('twilio', 'postmark', 'microsoft', 'google', 'fake', 'workflow', 'stripe', 'square', 'addon',
      'meta', 'livekit'));

-- ---------- the card ----------
-- Mirrors core's USAGE_KEYS; packages/db/test/parity.test.ts asserts the two lists are identical.
alter table platform.usage_rates drop constraint usage_rates_key_check;
alter table platform.usage_rates add constraint usage_rates_key_check check (key in (
  'number.local.month',
  'number.tollfree.month',
  'sms.outbound.segment',
  'sms.inbound.segment',
  'mms.outbound.message',
  'mms.inbound.message',
  'voice.outbound.minute',
  'voice.inbound.local.minute',
  'voice.inbound.tollfree.minute',
  'ai.input.mtok',
  'ai.output.mtok',
  'ai.cache_read.mtok',
  'ai.cache_write.mtok',
  'ai.opus.input.mtok',
  'ai.opus.output.mtok',
  'ai.opus.cache_read.mtok',
  'ai.opus.cache_write.mtok',
  'speech.live.minute',
  'speech.recording.minute',
  'speech.voice.kchar',
  'speech.meeting.minute',
  'video.minute',
  'ai.unknown.mtok',
  'a2p.brand.registration',
  'a2p.brand.vetting',
  'a2p.campaign.vetting',
  'a2p.campaign.month'
));

-- Kept in step with core's SEED_RATES: LiveKit Cloud's participant minute with its HD bandwidth, at 1.5×.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, 'video.minute', 'minute', 2000, 15000, 1, 'none',
  'One person for a minute in a HandsFreeOS video call: LiveKit Cloud''s participant minute ($0.0005) and about 11 MB of HD video ($0.12 a GB), about $0.002. Charged 0.3c, once per call.'
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
where not exists (
  select 1 from platform.usage_rates r where r.key = 'video.minute' and r.effective_to is null
);

-- ---------- attendance from who was really there ----------
-- A HandsFreeOS call knows who joined, so its customers are marked at its end like a session's, one-on-one visits
-- too: `joined_at` is set when they came into the call, not when they opened their link.
create or replace function private.attendance_to_close(p_limit integer)
returns table (attendee_id uuid, workspace_id uuid, organization_id uuid, joined boolean)
language sql stable security definer set search_path = '' as $$
  select aa.id, aa.workspace_id, w.organization_id, aa.joined_at is not null
  from app.appointment_attendees aa
    join app.appointments a on a.id = aa.appointment_id
    join app.workspaces w on w.id = aa.workspace_id
  where aa.status = 'booked'
    and aa.join_offered_at is not null
    and a.status <> 'cancelled'
    and (a.kind = 'session' or a.location ->> 'video' = 'handsfree')
    and a.ends_at < now() - interval '10 minutes'
    and a.ends_at > now() - interval '3 days'
  order by a.ends_at
  limit greatest(1, least(p_limit, 500))
$$;
