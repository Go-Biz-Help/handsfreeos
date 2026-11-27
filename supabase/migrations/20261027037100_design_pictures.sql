-- Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1): one library of pictures per business, put
-- on its forms, booking pages, emails, website chat and invoices.
--
--   - A person uploads a picture to the private `picture-uploads` bucket, at the place `picture.begin_upload` reserved
--     for them (a row here, `uploading`), and hands it over with `picture.use_upload` (`making`).
--   - The worker makes the copy everyone sees (WebP, at most 2000 pixels across, the camera's hidden details taken
--     out) in the public `pictures` bucket, so it shows on a client's website and in an email, and keeps it with
--     `picture.note_made` (`ready`, or `failed` with the words why). The upload is removed either way.
--   - Removing a picture takes it out of the library (`removed_at`); its file stays, so a page already showing it
--     doesn't break.
--
-- Anyone in the business sees the library. Adding, renaming and removing are for whoever may change how its pages
-- look: the business (workspace.update), its forms (forms.manage), its calendars (calendars.manage) or its channels
-- (channels.manage, for emails and the chat).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('pictures', 'pictures', true, 8388608, array['image/webp', 'image/png', 'image/jpeg']),
  ('picture-uploads', 'picture-uploads', false, 20971520,
   array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do nothing;

create or replace function private.can_add_pictures(p_ws uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return private.has_permission(p_ws, 'workspace.update')
    or private.has_permission(p_ws, 'forms.manage')
    or private.has_permission(p_ws, 'calendars.manage')
    or private.has_permission(p_ws, 'channels.manage');
end
$$;
revoke all on function private.can_add_pictures(uuid) from public;
grant execute on function private.can_add_pictures(uuid) to authenticated;

create table app.design_pictures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The picture's own name, as picked ("truck-door.jpg").
  name text not null check (char_length(btrim(name)) between 1 and 200),
  -- What it shows, for people who can't see it (screen readers) and when it doesn't load.
  words text not null default '' check (char_length(words) <= 300),
  status text not null default 'uploading' check (status in ('uploading', 'making', 'ready', 'failed')),
  -- Where the upload waits in `picture-uploads`, until the worker has made it.
  upload_path text unique check (upload_path is null or upload_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z]{3,4}$'),
  -- The copy everyone sees, in `pictures`, once it's ready.
  path text check (path is null or path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.webp$'),
  width int check (width is null or width between 1 and 10000),
  height int check (height is null or height between 1 and 10000),
  bytes int check (bytes is null or bytes >= 0),
  -- Why it couldn't be made, in words for the person.
  problem text check (problem is null or char_length(problem) <= 500),
  created_by uuid references app.users (id) on delete set null,
  removed_at timestamptz,
  removed_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'ready' or (path is not null and width is not null and height is not null))
);
comment on table app.design_pictures is
  'Your pictures: a business''s library of pictures for its forms, booking pages, emails, chat and invoices. The worker makes each into a public WebP.';
create index design_pictures_by_business_idx on app.design_pictures (workspace_id, created_at desc, id desc)
  where removed_at is null;
create trigger design_pictures_updated_at before update on app.design_pictures
  for each row execute function private.set_updated_at();
create trigger design_pictures_immutable before update on app.design_pictures
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

alter table app.design_pictures enable row level security;
create policy design_pictures_select on app.design_pictures for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy design_pictures_insert on app.design_pictures for insert to authenticated
  with check (private.can_add_pictures(workspace_id) and created_by = (select auth.uid())
    and status = 'uploading' and path is null and removed_at is null
    -- The upload waits in the business's own folder.
    and (upload_path is null or private.path_workspace(upload_path) = workspace_id));
create policy design_pictures_update on app.design_pictures for update to authenticated
  using (private.can_add_pictures(workspace_id))
  with check (private.can_add_pictures(workspace_id));
create policy design_pictures_service_all on app.design_pictures for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.design_pictures to authenticated;
grant update (name, words, status, removed_at, removed_by) on app.design_pictures to authenticated;
grant select, insert, update, delete on app.design_pictures to service_actor;
revoke all on app.design_pictures from anon;

create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (f.record_type <> 'document' or private.has_permission(f.workspace_id, 'documents.manage'))
        and (f.record_type <> 'form' or private.has_permission(f.workspace_id, 'forms.manage'))
        and (f.record_type <> 'expense' or private.has_permission(f.workspace_id, 'money.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    when 'picture-uploads' then exists (
      select 1 from app.design_pictures p
      where p.upload_path = p_name and p.status = 'uploading' and p.removed_at is null
        and p.workspace_id = private.path_workspace(p_name)
        and p.created_by = auth.uid() and private.can_add_pictures(p.workspace_id))
    when 'brand-uploads' then exists (
      select 1 from app.workspaces w
      where w.id = private.path_workspace(p_name)
        and w.settings -> 'look' -> 'upload' ->> 'path' = p_name
        and w.settings -> 'look' -> 'upload' ->> 'by' = (select auth.uid())::text
        and coalesce(w.settings -> 'look' -> 'upload' ->> 'sent', 'false') = 'false'
        and private.has_permission(w.id, 'workspace.update'))
    else false
  end;
end
$$;
