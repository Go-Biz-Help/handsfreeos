-- =============================================================================
-- A failed text tried again in quiet hours waits for them to end (M10).
--
--        message.retry used to send it at once, at night. Now it holds it the
--        way "Send at 8:00 AM" holds a new text: queued, marked scheduled,
--        with occurred_at set to the moment quiet hours end. The command runs
--        as the person pressing Retry, and 0011 let them change only a
--        message's status and error, so it also needs occurred_at. A person
--        already sets a held text's occurred_at when they write it
--        (message.send); this lets them set it on one they try again.
-- =============================================================================

grant update (occurred_at) on app.messages to authenticated;

-- Only a text still waiting to go can be moved: a sent or received message keeps the time it happened. The
-- worker (system scope) is trusted as it is for status.
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
  if old.direction = 'outbound' and new.status = 'queued' then
    return new;
  end if;
  raise exception 'Only a text waiting to go can be moved' using errcode = '42501', detail = 'message_time_change';
end $$;
create trigger messages_time_guard before update of occurred_at on app.messages for each row
  execute function private.guard_message_time();
revoke all on function private.guard_message_time() from public;
grant execute on function private.guard_message_time() to authenticated, service_actor;
