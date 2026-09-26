-- =============================================================================
-- A text that never went is known, with or without a customer (M10).
--
--        A text written to wait for quiet hours ("Send at 8:00 AM") hasn't
--        gone until they end, and cancelled or refused then (the customer
--        opted out overnight) it never does. The only sign of that was having
--        no timeline entry, and a conversation with no customer has no
--        timeline: linking it later gave a refused text an entry it never
--        earned, and trying it again by day never made it the conversation's
--        latest. `went` says it outright: false only for a text held from the
--        start, until it first goes. The timeline entry and the preview follow
--        it. The command runs as the person pressing Retry, so they may now
--        mark a text as gone as it goes, and never the other way.
-- =============================================================================

alter table app.messages add column went boolean not null default true;
grant update (went) on app.messages to authenticated;

-- Texts already waiting, cancelled or refused: held from the start (message.scheduled) and never handed to the
-- sender (message.queued). One that was given a timeline entry anyway keeps it, and counts as gone.
update app.messages m set went = false
where m.direction = 'outbound' and m.channel = 'sms' and m.activity_id is null
  and exists (
    select 1 from app.events e
    where e.entity_type = 'message' and e.entity_id = m.id and e.event_type = 'message.scheduled'
  )
  and not exists (
    select 1 from app.events e
    where e.entity_type = 'message' and e.entity_id = m.id and e.event_type = 'message.queued'
  );

-- A text that went stays gone, and a person marks one as gone only as it goes (queued). The worker (system scope)
-- is trusted.
create or replace function private.guard_message_went()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only people are held to this (the role a person's commands run as); the worker and the database's own
  -- upkeep (seeds, tests, support) aren't. `role` is a setting SECURITY DEFINER leaves alone.
  if coalesce(current_setting('role', true), '') <> 'authenticated' then
    return new;
  end if;
  if old.went is not distinct from new.went then
    return new;
  end if;
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.went and new.status = 'queued' then
    return new;
  end if;
  raise exception 'A text that went stays gone' using errcode = '42501', detail = 'message_went_change';
end $$;
create trigger messages_went_guard before update of went on app.messages for each row
  execute function private.guard_message_went();
revoke all on function private.guard_message_went() from public;
grant execute on function private.guard_message_went() to authenticated, service_actor;
