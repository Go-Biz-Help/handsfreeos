-- =============================================================================
-- 0008 · Live updates. Every row that lands in app.events with a workspace is
--        broadcast to the private Realtime topic `workspace:<id>` (ids only).
--        Subscribers are authorized by RLS on realtime.messages through the
--        membership helpers. The trigger is SECURITY DEFINER and owned by
--        postgres, which bypasses RLS on realtime.messages (verified locally
--        and on the hosted project); realtime.send swallows errors as warnings,
--        so packages/db/test/realtime.test.ts asserts a row really lands.
-- =============================================================================

create or replace function private.broadcast_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'type', new.event_type,
      'entityType', new.entity_type,
      'entityId', new.entity_id,
      'actorId', new.actor_id,
      'correlationId', new.correlation_id,
      'at', new.created_at
    ),
    'change',
    'workspace:' || new.workspace_id::text,
    true
  );
  return null;
end $$;
revoke all on function private.broadcast_event() from public;
grant execute on function private.broadcast_event() to authenticated, service_actor;

create trigger events_broadcast after insert on app.events
  for each row
  when (new.workspace_id is not null and coalesce(new.payload ->> '_broadcast', 'true') <> 'false')
  execute function private.broadcast_event();

-- The workspace a Realtime topic names, or null for any other topic shape.
create or replace function private.topic_workspace()
returns uuid language sql stable set search_path = '' as $$
  select case
    when realtime.topic() ~ '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then substr(realtime.topic(), 11)::uuid
  end
$$;
revoke all on function private.topic_workspace() from public;
grant execute on function private.topic_workspace() to authenticated;

-- realtime.messages belongs to the Realtime service's own migrations, so guard for stacks started without it.
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise warning 'realtime.messages does not exist: the live-updates policy was not created. Start the stack with Realtime enabled and re-run this migration.';
    return;
  end if;
  execute 'drop policy if exists workspace_members_receive on realtime.messages';
  execute $p$
    create policy workspace_members_receive on realtime.messages
      for select to authenticated
      using (extension = 'broadcast' and private.topic_workspace() in (select private.accessible_workspace_ids()))
  $p$;
end $$;
