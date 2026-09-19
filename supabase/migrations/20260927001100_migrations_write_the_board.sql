-- =============================================================================
-- The import may write the board it is bringing across.
--
--        `service_actor` — the worker, bound to one business by
--        `private.system_scope_workspace()` — has picked up write access to
--        these tables one milestone at a time, for whatever that milestone
--        needed: leads on insert for booking (0020), leads and tasks on update
--        for workflow steps (0024). Pipelines and their stages it could only
--        ever read, because until now nothing here made one.
--
--        A migration makes them. A business's board is its own — the stages it
--        named, in the order it had them — and bringing the deals without it
--        would land them in columns somebody else chose. Without these the
--        import failed on its first insert and reported the whole category as
--        failed, which is how it was found.
--
--        The same shape as every grant before it: one policy per table, every row
--        scoped to the job's own business, and a matching table privilege.
--        Nothing widens what a person can do, and the worker still reaches
--        exactly one workspace — the one its job belongs to.
--
--        `delete` on stages and leads is here because taking a migration back has
--        to be able to undo what it made, the way rollback already undoes
--        customers and companies.
-- =============================================================================

-- ---------- pipelines ----------
create policy pipelines_service_insert on app.pipelines for insert to service_actor
  with check (workspace_id = private.system_scope_workspace());
create policy pipelines_service_update on app.pipelines for update to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant insert, update on app.pipelines to service_actor;

-- ---------- stages: a stage belongs to a pipeline of the same business ----------
create policy stages_service_insert on app.pipeline_stages for insert to service_actor
  with check (workspace_id = private.system_scope_workspace()
    and pipeline_id in (select p.id from app.pipelines p
                        where p.workspace_id = app.pipeline_stages.workspace_id));
create policy stages_service_update on app.pipeline_stages for update to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
create policy stages_service_delete on app.pipeline_stages for delete to service_actor
  using (workspace_id = private.system_scope_workspace());
grant insert, update, delete on app.pipeline_stages to service_actor;

-- ---------- taking it back ----------
-- Insert and update are already the worker's (0020, 0024); only undoing was missing.
create policy leads_service_delete on app.leads for delete to service_actor
  using (workspace_id = private.system_scope_workspace());
create policy tasks_service_delete on app.tasks for delete to service_actor
  using (workspace_id = private.system_scope_workspace());
grant delete on app.leads, app.tasks to service_actor;
