-- =============================================================================
-- 0009 · Files. Two private buckets and policies on storage.objects that only
--        admit paths the server reserved first (app.files / app.imports rows):
--        users upload to a reserved path and read ready files in their
--        workspaces; nobody but the worker ever deletes an object.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('attachments', 'attachments', false, 26214400, array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv'
  ]),
  ('imports', 'imports', false, 10485760, array['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'])
on conflict (id) do nothing;

-- The workspace a server-made object path starts with, or null.
create or replace function private.path_workspace(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids()))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    else false
  end
$$;

create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_bucket = 'attachments' and exists (
    select 1 from app.files f
    where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
      and f.workspace_id in (select private.accessible_workspace_ids()))
$$;

-- Size and type of an object in a workspace the caller can reach (used by file.confirm and import.start).
create or replace function private.storage_object_info(p_bucket text, p_name text)
returns table (size_bytes bigint, mime_type text)
language sql stable security definer set search_path = '' as $$
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
  from storage.objects o
  where o.bucket_id = p_bucket and o.name = p_name
    and private.path_workspace(o.name) in (select private.accessible_workspace_ids())
$$;

revoke all on function private.path_workspace(text), private.storage_upload_allowed(text, text), private.storage_read_allowed(text, text), private.storage_object_info(text, text) from public;
grant execute on function private.path_workspace(text), private.storage_upload_allowed(text, text), private.storage_read_allowed(text, text), private.storage_object_info(text, text) to authenticated;
grant execute on function private.path_workspace(text) to service_actor;

drop policy if exists hfos_reserved_upload on storage.objects;
create policy hfos_reserved_upload on storage.objects for insert to authenticated
  with check (private.storage_upload_allowed(bucket_id, name));
drop policy if exists hfos_ready_read on storage.objects;
create policy hfos_ready_read on storage.objects for select to authenticated
  using (private.storage_read_allowed(bucket_id, name));
