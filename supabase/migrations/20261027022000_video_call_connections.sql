-- What a HandsFreeOS video call really used, connection by connection (docs/video-calls.md, "What a call used").
--
-- LiveKit bills two things: every connection's minutes, and the data it sends down to each one. Its webhooks give
-- us the minutes (who came in and left, on which connection). The data, each person's own app measures and reports
-- every minute while they're in the call (`video_call.data`). The AI's listener is a connection LiveKit bills too,
-- so its comings and goings are kept here as well.
--
-- Part 1 only keeps these. The balance is still charged the flat `video.minute` until part 2 prices each call from
-- these rows, so what it charges can first be checked against LiveKit's own bill.

create table app.video_call_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  video_call_id uuid not null,
  -- Whose connection: one of the call's people, or the AI's listener (which has no row of its own).
  kind text not null check (kind in ('person', 'listener')),
  -- Deleting a customer takes their part in the call, this included.
  person_row_id uuid references app.video_call_people (id) on delete cascade,
  -- LiveKit's id for the room as it ran (one stretch of the call), and for this one connection. A reload or a second
  -- phone is a new connection.
  room_sid text not null check (length(room_sid) between 1 and 100),
  participant_sid text not null check (length(participant_sid) between 1 and 100),
  joined_at timestamptz not null,
  -- When LiveKit said it left, or the room closed with it still open.
  left_at timestamptz,
  -- What their app says it has downloaded on this connection so far: everything LiveKit sent it (video, sound,
  -- screen share). It only ever goes up, and never past what 10 HD videos could carry in the time.
  bytes_received bigint not null default 0 check (bytes_received >= 0),
  -- When their app last said so; null when it never did (an old phone app, a page that closed at once).
  reported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, video_call_id) references app.video_calls (workspace_id, id) on delete cascade,
  unique (video_call_id, participant_sid),
  check ((kind = 'person') = (person_row_id is not null)),
  check (left_at is null or left_at >= joined_at)
);
create index video_call_connections_call_idx on app.video_call_connections (video_call_id, room_sid);
create index video_call_connections_workspace_idx on app.video_call_connections (workspace_id, joined_at desc);
create index video_call_connections_person_idx on app.video_call_connections (person_row_id)
  where person_row_id is not null;
create trigger video_call_connections_updated_at before update on app.video_call_connections
  for each row execute function private.set_updated_at();

comment on table app.video_call_connections is
  'Each LiveKit connection in a HandsFreeOS video call: when it came and went, and what its app downloaded. What the call really used, for its price.';

create or replace function private.check_video_call_connection_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.person_row_id is not null and not exists (
    select 1 from app.video_call_people p
    where p.id = new.person_row_id and p.video_call_id = new.video_call_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger video_call_connections_check_refs before insert or update on app.video_call_connections
  for each row execute function private.check_video_call_connection_refs();

-- What a call used is money: whoever can read the business's money can see it. Only the worker writes it.
alter table app.video_call_connections enable row level security;

create policy video_call_connections_select on app.video_call_connections for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and video_call_id in (select c.id from app.video_calls c));
create policy video_call_connections_service_all on app.video_call_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.video_call_connections to authenticated;
grant select, insert, update, delete on app.video_call_connections to service_actor;
revoke all on app.video_call_connections from anon;

grant execute on function private.check_video_call_connection_refs() to authenticated, service_actor;
