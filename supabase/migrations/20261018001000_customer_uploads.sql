-- =============================================================================
-- Files in a customer's portal (Real Estate round two, step 4; core).
--
--        A customer adds files from their portal (an ID, a pre-approval
--        letter), and the business shares files with them (an offer's
--        summary, the inspection report). Customers have no session with
--        Storage, so the worker hands their browser a one-time upload link
--        for a place the kernel reserved, and checks what arrived.
--
--        - `files.uploaded_by_person_id`: the customer who added it. Only
--          the worker sets it, once.
--        - `files.portal_visible`: shown in the portal of the customer it's
--          on, or of the customers on its record through a portal-visible
--          relationship. A customer's own files are; the business shares
--          others (file.share_to_portal).
--        - portal_actor reads those, ready and not deleted, a few columns.
-- =============================================================================

alter table app.files
  add column uploaded_by_person_id uuid references app.people (id) on delete set null,
  add column portal_visible boolean not null default false,
  -- Only a customer's own files, or a record's: never the business's own papers.
  add constraint files_portal_check check (
    (not portal_visible and uploaded_by_person_id is null) or record_type in ('person', 'custom_record'));
create index files_uploaded_by_person_idx on app.files (uploaded_by_person_id, created_at)
  where uploaded_by_person_id is not null;

comment on column app.files.uploaded_by_person_id is 'The customer who added it from their portal (set by the worker alone).';
comment on column app.files.portal_visible is 'Shown in the portal of the customers it''s about.';

-- Nobody in the business says a customer added something.
create or replace function private.keep_file_uploader()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and (
      (tg_op = 'INSERT' and new.uploaded_by_person_id is not null)
      or (tg_op = 'UPDATE' and new.uploaded_by_person_id is distinct from old.uploaded_by_person_id)) then
    raise exception 'Only a customer adds their own files' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger files_keep_uploader before insert or update of uploaded_by_person_id on app.files
  for each row execute function private.keep_file_uploader();

-- The worker reserves a customer's upload, as it reserves nothing else.
grant insert on app.files to service_actor;

-- What arrived, for the worker in its own business too (a customer's upload is checked there).
create or replace function private.storage_object_info(p_bucket text, p_name text)
returns table (size_bytes bigint, mime_type text)
language sql stable security definer set search_path = '' as $$
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
  from storage.objects o
  where o.bucket_id = p_bucket and o.name = p_name
    and (private.path_workspace(o.name) in (select private.accessible_workspace_ids())
      or (current_setting('role', true) = 'service_actor'
        and private.path_workspace(o.name) = private.system_scope_workspace()))
$$;
grant execute on function private.storage_object_info(text, text) to service_actor;

-- ---------- what a customer reads ----------
create policy files_portal_select on app.files for select to portal_actor
  using (workspace_id = (select portal.workspace()) and portal_visible and status = 'ready' and deleted_at is null
    and ((record_type = 'custom_record' and record_id in (select portal.records()))
      or (record_type = 'person' and record_id = (select portal.person()))));
grant select (id, workspace_id, record_type, record_id, name, mime_type, size_bytes, status, deleted_at,
  portal_visible, uploaded_by_person_id, locked_at, created_at) on app.files to portal_actor;
