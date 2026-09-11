-- =============================================================================
-- 0010 · The import worker creates tags and applies them while it runs
--        person.create / company.create as the system actor. service_actor
--        stays bound to its job's workspace (private.system_scope_workspace()).
-- =============================================================================

create policy tags_service_insert on app.tags for insert to service_actor
  with check (workspace_id = private.system_scope_workspace());

create policy record_tags_service_insert on app.record_tags for insert to service_actor
  with check (workspace_id = private.system_scope_workspace()
    and tag_id in (select t.id from app.tags t where t.workspace_id = app.record_tags.workspace_id));
create policy record_tags_service_delete on app.record_tags for delete to service_actor
  using (workspace_id = private.system_scope_workspace());

-- Table privileges to match (RLS still scopes every row to the job's workspace).
grant insert on app.tags to service_actor;
grant insert, delete on app.record_tags to service_actor;
