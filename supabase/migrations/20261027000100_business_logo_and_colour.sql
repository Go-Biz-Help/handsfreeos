-- =============================================================================
-- A business's logo and colour (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
--        §4, "Your logo and colour"): on its booking page, website chat,
--        invoices and the emails HandsFreeOS sends for it. They're kept in
--        app.workspaces.settings.look, written only by the look commands
--        (packages/core/src/commands/look.ts).
--
--        - `brand` holds the logos the worker made: PNGs, public, so emails and
--          websites can show them for good. Only the worker writes there.
--        - `brand-uploads` holds a picture someone uploads, privately, at the
--          one place look.begin_upload reserved for them, until the worker makes
--          the PNG from it.
--        - The worker only reads businesses. private.lock_look() and
--          private.keep_look() let it read and write the look of the business it
--          is working for, and nothing else in its settings.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('brand', 'brand', true, 2097152, array['image/png']),
  ('brand-uploads', 'brand-uploads', false, 5242880,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'])
on conflict (id) do nothing;

-- Every bucket a person uploads to, in one place, as each milestone that adds one rewrites this whole function.
-- `brand-uploads`: the place reserved in the business's look, by this person, not yet handed over, while they may
-- still change the business's settings.
create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    when 'brand-uploads' then exists (
      select 1 from app.workspaces w
      where w.id = private.path_workspace(p_name)
        and w.settings -> 'look' -> 'upload' ->> 'path' = p_name
        and w.settings -> 'look' -> 'upload' ->> 'by' = (select auth.uid())::text
        and coalesce(w.settings -> 'look' -> 'upload' ->> 'sent', 'false') = 'false'
        and private.has_permission(w.id, 'workspace.update'))
    else false
  end
$$;

-- The look of the business the worker is working for, with its website, its row held until the command saves.
create or replace function private.lock_look()
returns jsonb language sql volatile security definer set search_path = '' as $$
  select jsonb_build_object('look', w.settings -> 'look', 'website', w.settings -> 'website')
  from app.workspaces w
  where current_setting('role', true) = 'service_actor' and w.id = private.system_scope_workspace()
  for update
$$;

-- Keeps the look of the business the worker is working for, and nothing else in its settings.
create or replace function private.keep_look(p_look jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if current_setting('role', true) is distinct from 'service_actor' or private.system_scope_workspace() is null then
    raise exception 'Only the worker keeps a business''s look this way' using errcode = '42501';
  end if;
  if jsonb_typeof(p_look) is distinct from 'object' then
    raise exception 'A business''s look is an object' using errcode = '22023';
  end if;
  update app.workspaces
    set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{look}', p_look, true)
    where id = private.system_scope_workspace();
end $$;

revoke all on function private.lock_look(), private.keep_look(jsonb) from public;
grant execute on function private.lock_look(), private.keep_look(jsonb) to service_actor;
