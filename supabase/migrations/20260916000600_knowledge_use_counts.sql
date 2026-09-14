-- =============================================================================
-- 0026 · Counting use isn't a change. knowledge_item.record_use raises
--        use_count and last_used_at each time an AI step or the Assistant
--        uses an item, and the generic set_updated_at trigger moved
--        updated_at with them: "last changed" showed the last time the AI
--        read the item, and knowledge_item.list (newest change first)
--        reshuffled whenever the AI answered. An update that changes nothing
--        but those two columns now leaves updated_at alone; any other change
--        still stamps it.
-- =============================================================================

create or replace function private.knowledge_items_set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Compare everything except the use counters, updated_at itself, and the generated search column (not yet
  -- computed in a BEFORE trigger).
  if (to_jsonb(new) - array['use_count', 'last_used_at', 'updated_at', 'search'])
     = (to_jsonb(old) - array['use_count', 'last_used_at', 'updated_at', 'search']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke all on function private.knowledge_items_set_updated_at() from public;
grant execute on function private.knowledge_items_set_updated_at() to authenticated, service_actor;

-- Same name, so it still runs after knowledge_items_immutable (triggers fire in name order).
drop trigger knowledge_items_updated_at on app.knowledge_items;
create trigger knowledge_items_updated_at before update on app.knowledge_items
  for each row execute function private.knowledge_items_set_updated_at();
