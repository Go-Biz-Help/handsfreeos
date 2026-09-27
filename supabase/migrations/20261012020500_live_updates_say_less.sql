-- =============================================================================
-- Live updates say less about the inbox and the money (SEC-L2).
--
--        Every event is broadcast to `workspace:<id>`, which everyone who can
--        open the business may join (0008). Ids only, never row data — but the
--        ids were enough: a member narrowed to their own threads (0083), or one
--        the business keeps away from its money, watched which conversation
--        just got a message and who answered it, and which invoice was just
--        paid, by whom.
--
--        The topic cannot tell its subscribers apart, so for those events it
--        now says only what happened to what kind of thing: the type and the
--        entity type stay, because they are what a screen refreshes on (the
--        inbox on `message`, the money lists on `invoice`), and the entity and
--        the person are left out. A screen that is allowed to see the row asks
--        the API for it, as it always did.
--
--        `actorType` is added so the web can still drop the echo of its own
--        edits without being told who made them: a person's event with this
--        tab's correlation id is its own.
-- =============================================================================

create or replace function private.broadcast_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_quiet boolean;
begin
  v_quiet := coalesce(
    new.entity_type in ('conversation', 'message', 'call', 'ai_teammate_draft',
                        'estimate', 'invoice', 'payment', 'refund', 'subscription')
    or split_part(new.event_type, '.', 1) in ('conversation', 'message', 'call', 'assistant',
                                              'estimate', 'invoice', 'payment', 'refund', 'subscription'),
    false);
  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'type', new.event_type,
      'entityType', new.entity_type,
      'entityId', case when v_quiet then null else new.entity_id end,
      'actorType', new.actor_type,
      'actorId', case when v_quiet then null else new.actor_id end,
      'correlationId', new.correlation_id,
      'at', new.created_at
    ),
    'change',
    'workspace:' || new.workspace_id::text,
    true
  );
  return null;
end $$;
