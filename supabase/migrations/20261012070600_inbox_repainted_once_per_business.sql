-- =============================================================================
-- A permission change repaints a business's threads once, not once per person
-- (PERF-M25).
--
--        0083 and 0106 repaint every thread in a business whenever one
--        person's access row there changes: their role, their permissions,
--        their access starting or ending. Row by row. Changing a role's
--        setting refreshes everyone with that role, one statement each, so a
--        business with twelve members and forty thousand threads was repainted
--        twelve times over inside the owner's request — and a change to the
--        defaults did that for every business at once. The switch itself has
--        a ceiling; this path had none.
--
--        Every one of those repaints after the first found nothing to do: the
--        list depends on who is in the business and what they may do, which
--        is settled once the last row has moved. So the triggers now wait for
--        the end of the transaction (deferred, as the custom-field and
--        receipt checks already do), and the first to fire for a business
--        repaints it from the finished access rows; the rest see that it is
--        done. Nothing a repaint writes moves an access row, so no later
--        change in the same commit can be missed.
--
--        Still a no-op, and one index probe per business, while a business has
--        not opted in.
-- =============================================================================

create or replace function private.inbox_viewers_access_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  -- The businesses already repainted at this commit. Transaction-local, so it is empty again for the next one.
  v_done text := coalesce(current_setting('app.inbox_repainted', true), '');
begin
  if position(v_ws::text in v_done) > 0 then
    return null;
  end if;
  perform set_config('app.inbox_repainted', v_done || v_ws::text || ',', true);
  if not private.inbox_per_person(v_ws) then
    return null;
  end if;
  perform private.inbox_repaint_workspace(v_ws);
  return null;
end $$;

drop trigger if exists workspace_access_inbox_viewers on app.workspace_access;
create constraint trigger workspace_access_inbox_viewers after insert or delete on app.workspace_access
  deferrable initially deferred
  for each row execute function private.inbox_viewers_access_changed();
drop trigger if exists workspace_access_inbox_viewers_changed on app.workspace_access;
create constraint trigger workspace_access_inbox_viewers_changed after update on app.workspace_access
  deferrable initially deferred
  for each row
  when (old.role is distinct from new.role or old.permissions is distinct from new.permissions)
  execute function private.inbox_viewers_access_changed();
