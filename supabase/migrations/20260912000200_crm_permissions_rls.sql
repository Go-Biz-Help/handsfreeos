-- =============================================================================
-- 0007 · CRM permissions and Row Level Security for the tables from 0006.
--        Human requests run as `authenticated`; the worker as `service_actor`
--        scoped by app.system_scope.workspace_id. Column-conditional rules
--        (archive, file status, system activities) live in triggers (0006/0007)
--        because permissive policies OR together and `with check` cannot see
--        the old row.
-- =============================================================================

insert into app.role_permissions (role, permission) values
  ('owner', 'records.read'), ('owner', 'records.write'), ('owner', 'records.archive'), ('owner', 'records.import'),
  ('owner', 'pipelines.manage'), ('owner', 'tags.manage'), ('owner', 'files.delete'),
  ('admin', 'records.read'), ('admin', 'records.write'), ('admin', 'records.archive'), ('admin', 'records.import'),
  ('admin', 'pipelines.manage'), ('admin', 'tags.manage'), ('admin', 'files.delete'),
  ('member', 'records.read'), ('member', 'records.write');

-- ---------- file rows: who may flip status and who may mark deleted ----------
create or replace function private.guard_file_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_in_scope boolean := coalesce(private.system_scope_workspace() = new.workspace_id, false);
begin
  if old.status is distinct from new.status then
    if not (old.status = 'pending' and new.status = 'ready') then
      raise exception 'A file only moves from pending to ready' using errcode = '23514', detail = 'file_status_transition';
    end if;
    if not (v_in_scope or coalesce(old.created_by = auth.uid(), false)) then
      raise exception 'Only the uploader confirms a file' using errcode = '42501', detail = 'file_confirm_forbidden';
    end if;
  end if;
  if old.deleted_at is distinct from new.deleted_at then
    if not (v_in_scope or coalesce(old.created_by = auth.uid(), false) or coalesce(private.has_permission(new.workspace_id, 'files.delete'), false)) then
      raise exception 'Deleting this file needs the files.delete permission' using errcode = '42501', detail = 'file_delete_forbidden';
    end if;
    new.deleted_by := case when new.deleted_at is null then null else coalesce(auth.uid(), new.deleted_by) end;
  end if;
  return new;
end $$;
create trigger files_update_guard before update on app.files for each row execute function private.guard_file_update();
revoke all on function private.guard_file_update() from public;
grant execute on function private.guard_file_update() to authenticated, service_actor;

-- ---------- enable RLS ----------
alter table app.pipelines enable row level security;
alter table app.pipeline_stages enable row level security;
alter table app.companies enable row level security;
alter table app.people enable row level security;
alter table app.tags enable row level security;
alter table app.record_tags enable row level security;
alter table app.leads enable row level security;
alter table app.tasks enable row level security;
alter table app.activities enable row level security;
alter table app.files enable row level security;
alter table app.imports enable row level security;
alter table app.import_errors enable row level security;

-- ---------- pipelines ----------
create policy pipelines_select on app.pipelines for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy pipelines_insert on app.pipelines for insert to authenticated
  with check (private.has_permission(workspace_id, 'pipelines.manage') and created_by = (select auth.uid()));
create policy pipelines_update on app.pipelines for update to authenticated
  using (private.has_permission(workspace_id, 'pipelines.manage'))
  with check (private.has_permission(workspace_id, 'pipelines.manage'));
create policy pipelines_service_select on app.pipelines for select to service_actor
  using (workspace_id = private.system_scope_workspace());

create policy stages_select on app.pipeline_stages for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy stages_insert on app.pipeline_stages for insert to authenticated
  with check (private.has_permission(workspace_id, 'pipelines.manage'));
create policy stages_update on app.pipeline_stages for update to authenticated
  using (private.has_permission(workspace_id, 'pipelines.manage'))
  with check (private.has_permission(workspace_id, 'pipelines.manage'));
create policy stages_delete on app.pipeline_stages for delete to authenticated
  using (private.has_permission(workspace_id, 'pipelines.manage'));
create policy stages_service_select on app.pipeline_stages for select to service_actor
  using (workspace_id = private.system_scope_workspace());

-- ---------- companies and people ----------
create policy companies_select on app.companies for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy companies_insert on app.companies for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()));
create policy companies_update on app.companies for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy companies_service_all on app.companies for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy people_select on app.people for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy people_insert on app.people for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()));
create policy people_update on app.people for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy people_service_all on app.people for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- tags ----------
create policy tags_select on app.tags for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy tags_insert on app.tags for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()));
create policy tags_update on app.tags for update to authenticated
  using (private.has_permission(workspace_id, 'tags.manage'))
  with check (private.has_permission(workspace_id, 'tags.manage'));
create policy tags_delete on app.tags for delete to authenticated
  using (private.has_permission(workspace_id, 'tags.manage'));
create policy tags_service_select on app.tags for select to service_actor
  using (workspace_id = private.system_scope_workspace());

create policy record_tags_select on app.record_tags for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy record_tags_insert on app.record_tags for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid())
    and tag_id in (select t.id from app.tags t where t.workspace_id = app.record_tags.workspace_id));
create policy record_tags_delete on app.record_tags for delete to authenticated
  using (private.has_permission(workspace_id, 'records.write'));
create policy record_tags_service_select on app.record_tags for select to service_actor
  using (workspace_id = private.system_scope_workspace());

-- ---------- leads ----------
create policy leads_select on app.leads for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy leads_insert on app.leads for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()));
create policy leads_update on app.leads for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy leads_service_select on app.leads for select to service_actor
  using (workspace_id = private.system_scope_workspace());

-- ---------- tasks ----------
create policy tasks_select on app.tasks for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy tasks_insert on app.tasks for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()));
create policy tasks_update on app.tasks for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy tasks_delete on app.tasks for delete to authenticated
  using (created_by = (select auth.uid()) or private.has_permission(workspace_id, 'records.archive'));
create policy tasks_service_select on app.tasks for select to service_actor
  using (workspace_id = private.system_scope_workspace());

-- ---------- activities ----------
create policy activities_select on app.activities for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy activities_insert on app.activities for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and actor_type = 'human' and author_user_id = (select auth.uid()));
create policy activities_update on app.activities for update to authenticated
  using (kind <> 'system' and author_user_id = (select auth.uid()))
  with check (kind <> 'system' and author_user_id = (select auth.uid()));
create policy activities_delete on app.activities for delete to authenticated
  using (kind <> 'system' and (author_user_id = (select auth.uid()) or private.has_permission(workspace_id, 'records.archive')));
create policy activities_service_select on app.activities for select to service_actor
  using (workspace_id = private.system_scope_workspace());
create policy activities_service_insert on app.activities for insert to service_actor
  with check (workspace_id = private.system_scope_workspace() and actor_type <> 'human');

-- ---------- files ----------
create policy files_select on app.files for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy files_insert on app.files for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and created_by = (select auth.uid()) and status = 'pending' and deleted_at is null);
create policy files_update on app.files for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy files_service_all on app.files for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- imports ----------
create policy imports_select on app.imports for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy imports_insert on app.imports for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.import') and created_by = (select auth.uid()) and status = 'pending');
create policy imports_update on app.imports for update to authenticated
  using (private.has_permission(workspace_id, 'records.import'))
  with check (private.has_permission(workspace_id, 'records.import'));
create policy imports_service_all on app.imports for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy import_errors_select on app.import_errors for select to authenticated
  using (private.has_permission(workspace_id, 'records.import'));
create policy import_errors_service_all on app.import_errors for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
