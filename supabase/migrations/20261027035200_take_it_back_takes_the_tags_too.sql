-- =============================================================================
-- Take it back takes the move's tags too (the owner's decision, 2026-11-23)
--
-- A tag a move made used to stay after the move was taken back. Now the
-- rollback deletes it, unless something of the business's own still uses it
-- (the worker decides that: apps/worker/src/migrations/engine/run.ts).
--
-- The worker could make tags but never delete one. It may now delete only a
-- tag in its job's business that a move's journal says a move made, so it
-- still can't touch a tag somebody here made.
-- =============================================================================

create policy tags_service_delete on app.tags for delete to service_actor
  using (
    workspace_id = private.system_scope_workspace()
    and exists (
      select 1 from app.migration_change_journal j
       where j.workspace_id = app.tags.workspace_id
         and j.target_type = 'tag'
         and j.target_id = app.tags.id
         and j.action = 'create'
    )
  );

grant delete on app.tags to service_actor;
