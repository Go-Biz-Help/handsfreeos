-- =============================================================================
-- 0028 · Knowledge files, part 2. A knowledge file belongs to the business
--        itself (its record_id is the workspace) and lives at
--        <workspace>/knowledge/<file>/<name>. Reserving, uploading and
--        confirming one takes knowledge.manage (owners, admins) instead of
--        records.write. Everyone in the workspace still reads ready files, as
--        everyone reads the knowledge base, so the read rule is unchanged.
--        Tags stay for customers and leads. app.files and app.record_tags are
--        the only users of app.record_type, and no function switches on it.
-- =============================================================================

alter table app.files
  add constraint files_knowledge_belongs_to_workspace
  check (record_type <> 'knowledge' or record_id = workspace_id);

alter table app.record_tags
  add constraint record_tags_not_knowledge check (record_type <> 'knowledge');

-- ---------- file rows: knowledge files need knowledge.manage, customer files records.write ----------
drop policy if exists files_insert on app.files;
create policy files_insert on app.files for insert to authenticated
  with check (
    private.has_permission(workspace_id,
      case when record_type = 'knowledge' then 'knowledge.manage' else 'records.write' end)
    and created_by = (select auth.uid()) and status = 'pending' and deleted_at is null);
drop policy if exists files_update on app.files;
create policy files_update on app.files for update to authenticated
  using (private.has_permission(workspace_id,
    case when record_type = 'knowledge' then 'knowledge.manage' else 'records.write' end))
  with check (private.has_permission(workspace_id,
    case when record_type = 'knowledge' then 'knowledge.manage' else 'records.write' end));

-- ---------- storage: an upload to a knowledge path also needs knowledge.manage when it happens ----------
-- The rule still admits only the uploader's own pending reservation; someone who lost knowledge.manage
-- after reserving can't finish the upload.
create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage')))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    else false
  end
$$;
