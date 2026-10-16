-- A live meeting's customer can be named while it's live (AI Sales Coach, round three).
--
-- Zoom's auto-start begins a meeting's stream as its person joins, often before HandsFreeOS's app in the meeting has
-- claimed it; the worker then claims it for them (`live_meeting.auto_claim`), without a customer. The app, opened
-- after, names the customer and the meeting it's in on that live claim. The person may change those four things
-- while it's live; the stream stays the worker's, as before.

create or replace function private.guard_live_meeting_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.state = 'live' and new.state = 'live' then
    if new.stream_id is distinct from old.stream_id or new.started_at is distinct from old.started_at
       or new.ended_at is distinct from old.ended_at then
      raise exception 'The stream is the worker''s' using errcode = '42501', detail = 'live_meeting_state_transition';
    end if;
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
