-- =============================================================================
-- 0082 · Who may put a signed authorisation up, and who may read it back.
--
--        The twin of 0028, which did this for knowledge files. Three rules, all
--        of them the same rule said in the three places Postgres makes you say
--        it:
--
--          reserve a row   app.files insert/update policy
--          upload the byte private.storage_upload_allowed
--          read it back    private.storage_read_allowed
--
--        **The read rule is the one that is different from knowledge.** Everyone
--        in a business reads its knowledge base on purpose. A signed
--        authorisation carries the service address on the old carrier's account
--        and the name of whoever signed it, so it is narrowed to the people who
--        could manage the number anyway — the same `channels.manage` that gates
--        the port itself. The PIN is not in the file at all; it never leaves
--        app.number_ports.submission.
-- =============================================================================

-- A port file's record is the port. Tagging one is meaningless, the way tagging a knowledge file is.
alter table app.record_tags
  add constraint record_tags_not_port check (record_type <> 'port');

-- ---------- reserving the row ----------
drop policy if exists files_insert on app.files;
create policy files_insert on app.files for insert to authenticated
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge' then 'knowledge.manage'
        when 'port' then 'channels.manage'
        else 'records.write'
      end)
    and created_by = (select auth.uid()) and status = 'pending' and deleted_at is null);
drop policy if exists files_update on app.files;
create policy files_update on app.files for update to authenticated
  using (private.has_permission(workspace_id,
    case record_type
      when 'knowledge' then 'knowledge.manage'
      when 'port' then 'channels.manage'
      else 'records.write'
    end))
  with check (private.has_permission(workspace_id,
    case record_type
      when 'knowledge' then 'knowledge.manage'
      when 'port' then 'channels.manage'
      else 'records.write'
    end));

-- ---------- uploading the bytes ----------
-- Still only the uploader's own pending reservation: somebody who lost channels.manage after reserving
-- cannot finish the upload, exactly as 0028 arranged for knowledge.
create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage')))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    else false
  end
$$;

-- ---------- reading it back ----------
-- All four buckets in one place, as every milestone that adds one rewrites this whole function. The
-- `migrations` and `telephony` arms are 0066's and 0013's, carried over unchanged; only `attachments` gains
-- a clause.
create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage')))
    when 'telephony' then coalesce(private.path_workspace(p_name) in (select private.accessible_workspace_ids()), false)
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end
$$;
