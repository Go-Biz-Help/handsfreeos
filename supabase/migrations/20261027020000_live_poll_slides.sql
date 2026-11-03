-- =============================================================================
-- Webinars, part 4: the presenter's slides inside HandsFreeOS
-- (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's answers of 29 October 2026).
--
--        A live poll can hold the presentation as a PDF. The AI reads it to
--        tie each question to its slide and write when-to-ask phrases from
--        what the slides say; in the call the team shows the slides on the
--        stage, slide by slide, and the AI hearing them knows which slide is
--        up.
--
--        - **The PDF belongs to the poll's form** (record type `form`,
--          20261027019700): reserved, uploaded and read like a template's
--          PDF, behind forms.manage. It is never on a customer, so nothing
--          tags it and no timeline hears of it.
--        - **The call keeps the slide that's showing** (`video_calls.slide`,
--          counted from 1; null while the slides aren't up) and when it
--          changed. The worker tells the room each change.
--
-- Only widens.
-- =============================================================================

-- ---------- the poll's PDF: reserved, uploaded and read like a template's, behind forms.manage ----------
-- A poll's slides have nothing to tag.
alter table app.record_tags
  add constraint record_tags_not_form check (record_type <> 'form');

drop policy files_insert on app.files;
create policy files_insert on app.files for insert to authenticated
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        when 'form'::app.record_type then 'forms.manage'
        else 'records.write'
      end)
    and created_by = (select auth.uid()) and status = 'pending'::app.file_status and deleted_at is null
    and (not sealed or private.custom_record_visible(record_id)));
drop policy files_update on app.files;
create policy files_update on app.files for update to authenticated
  using (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        when 'form'::app.record_type then 'forms.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)))
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        when 'form'::app.record_type then 'forms.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)));

-- Carried over from 20261027015200 with one more clause: a poll's slides are uploaded by someone who makes forms.
create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (f.record_type <> 'document' or private.has_permission(f.workspace_id, 'documents.manage'))
        and (f.record_type <> 'form' or private.has_permission(f.workspace_id, 'forms.manage'))
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

-- ---------- the slide that's showing in a call ----------
alter table app.video_calls
  add column slide integer check (slide between 1 and 1000),
  add column slide_at timestamptz;

comment on column app.video_calls.slide is
  'The slide of the live poll''s PDF showing on the stage, counted from 1; null while the slides aren''t up.';
comment on column app.video_calls.slide_at is 'When the slide showing last changed.';

-- The team turns the slides as they present, like the poll itself.
grant update (slide, slide_at) on app.video_calls to authenticated;
