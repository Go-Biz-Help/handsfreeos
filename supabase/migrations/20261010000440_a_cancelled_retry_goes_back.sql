-- =============================================================================
-- A failed text tried again in quiet hours, then cancelled, goes back (M10).
--
--        Cancelling a held text takes it out of the conversation: it never
--        went. A failed text tried again in quiet hours (message.retry) was in
--        the conversation already, not delivered and on the timeline, so
--        cancelling the retry puts it back as it was, to be tried again later.
--        failed_attempt keeps how that attempt stood (status, error, time)
--        while the retry waits. The command runs as the person pressing
--        Cancel, so they may now put a held retry back to the status it had,
--        at the time it had.
--
--        And a held text refused when quiet hours ended (the customer opted
--        out overnight) never went, so it has no timeline entry. Tried again
--        by day, it gets one then, as the person pressing Retry: they may
--        now give a message its entry, once, and only an entry about it.
-- =============================================================================

alter table app.messages add column failed_attempt jsonb;
grant update (failed_attempt, activity_id) on app.messages to authenticated;

-- A message's timeline entry is set once, when it first goes, to an entry that names it. The worker (system scope)
-- is trusted, and an entry deleted from the timeline lets go of its message (on delete set null).
create or replace function private.guard_message_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only people are held to this (the role a person's commands run as); the worker and the database's own
  -- upkeep (seeds, tests, support) aren't. `role` is a setting SECURITY DEFINER leaves alone.
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return new;
  end if;
  if old.activity_id is not distinct from new.activity_id or new.activity_id is null then
    return new;
  end if;
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.activity_id is null and exists (
    select 1 from app.activities a
    where a.id = new.activity_id and a.workspace_id = new.workspace_id and a.meta ->> 'messageId' = new.id::text
  ) then
    return new;
  end if;
  raise exception 'A message keeps its timeline entry' using errcode = '42501', detail = 'message_activity_change';
end $$;
create trigger messages_activity_guard before update of activity_id on app.messages for each row
  execute function private.guard_message_activity();
revoke all on function private.guard_message_activity() from public;
grant execute on function private.guard_message_activity() to authenticated, service_actor;

create or replace function private.guard_message_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is not distinct from new.status then
    return new;
  end if;
  if old.direction = 'inbound' or new.status = 'received' then
    raise exception 'Received messages keep their status' using errcode = '23514', detail = 'message_status_transition';
  end if;
  if old.status in ('failed', 'undelivered') and new.status = 'queued' then
    return new;
  end if;
  -- A held retry, cancelled: back to the status its failed attempt had, and never anything but not delivered.
  if old.status = 'queued' and old.error_code = 'scheduled' and new.status in ('failed', 'undelivered')
     and new.status::text = old.failed_attempt ->> 'status' then
    return new;
  end if;
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    if private.message_status_rank(new.status) < private.message_status_rank(old.status) then
      new.status := old.status;
    end if;
    return new;
  end if;
  raise exception 'Only a message that failed can be sent again' using errcode = '42501', detail = 'message_status_transition';
end $$;

-- A held text may also move back to the time it had when its retry is cancelled.
create or replace function private.guard_message_time()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only people are held to this (the role a person's commands run as); the worker and the database's own
  -- upkeep (seeds, tests, support) aren't. `role` is a setting SECURITY DEFINER leaves alone.
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return new;
  end if;
  if old.occurred_at is not distinct from new.occurred_at then
    return new;
  end if;
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.direction = 'outbound' and (new.status = 'queued' or (old.status = 'queued' and old.error_code = 'scheduled')) then
    return new;
  end if;
  raise exception 'Only a text waiting to go can be moved' using errcode = '42501', detail = 'message_time_change';
end $$;
