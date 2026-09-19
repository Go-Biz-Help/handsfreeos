-- =============================================================================
-- 0079 · The wording you reuse (M16).
--
--        A business that has been going a while has said the same twenty things
--        a thousand times: the quote follow-up, the "we're on our way", the
--        apology for a late van, the winter service reminder. Until now
--        HandsFreeOS had nowhere to keep any of it. The wording lived inside a
--        workflow step, where it could only be used by that workflow, or inside
--        somebody's head.
--
--        This is the library. A template is a name, a channel, and the words —
--        with the same {{placeholders}} a workflow step uses, so the two are
--        the same language and a template can be dropped into either.
--
--        It is also the last thing a business loses by leaving another CRM: the
--        migration brings these across now, which it could not do while there
--        was no shelf to put them on.
-- =============================================================================

-- A text has no subject, and an email does. Anything else is the same wording.
create type app.template_channel as enum ('sms', 'email');

create table app.message_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- What the business calls it in the picker: "On our way", "Quote follow-up".
  name text not null check (length(btrim(name)) between 1 and 120),
  channel app.template_channel not null default 'sms',
  -- Email only, and the check below holds that.
  subject text check (subject is null or length(btrim(subject)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 20000),
  -- The business's own grouping, one word deep on purpose: folders inside folders are how a library
  -- becomes a filing cabinet nobody opens. Null is "everything else".
  folder text check (folder is null or length(btrim(folder)) between 1 and 60),
  -- What gets reached for most rises to the top of the picker, so the library sorts itself.
  used_count integer not null default 0 check (used_count between 0 and 1000000000),
  last_used_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  -- Kept rather than deleted: a template that was used is part of why a message reads as it does.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A text message has no subject line. Storing one would be storing something nobody will ever send.
  check (channel = 'email' or subject is null)
);
-- Two templates with the same name are two templates somebody has to tell apart in a list.
create unique index message_templates_name on app.message_templates (workspace_id, lower(btrim(name)))
  where archived_at is null;
-- The picker: what this business has, most-used first.
create index message_templates_pick on app.message_templates
  (workspace_id, channel, used_count desc, lower(name)) where archived_at is null;
create index message_templates_created_by_idx on app.message_templates (created_by);
create trigger message_templates_updated_at before update on app.message_templates
  for each row execute function private.set_updated_at();
create trigger message_templates_immutable before update on app.message_templates
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- permissions ----------
-- Everyone reads and uses them; the people who run the business decide what the business says.
insert into app.role_permissions (role, permission) values
  ('owner', 'templates.manage'), ('admin', 'templates.manage');

-- ---------- RLS ----------
alter table app.message_templates enable row level security;

create policy message_templates_select on app.message_templates for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy message_templates_insert on app.message_templates for insert to authenticated
  with check (private.has_permission(workspace_id, 'templates.manage')
    and created_by = (select auth.uid()));
create policy message_templates_update on app.message_templates for update to authenticated
  using (private.has_permission(workspace_id, 'templates.manage'))
  with check (private.has_permission(workspace_id, 'templates.manage'));
create policy message_templates_delete on app.message_templates for delete to authenticated
  using (private.has_permission(workspace_id, 'templates.manage'));
create policy message_templates_service_all on app.message_templates for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- reaching for one ----------
-- Counting a use is a write, and the person doing it is usually not the person who decides what the
-- business says. Row-level security cannot say "this role may change only these two columns", so the count
-- goes through here instead: anyone who can use the inbox may say they used a template, and that is all
-- this can do to it.
create or replace function private.template_used(p_workspace uuid, p_template uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if not (coalesce(private.has_permission(p_workspace, 'inbox.use'), false)
          or coalesce(private.system_scope_workspace() = p_workspace, false)) then
    raise exception 'You cannot use this business''s templates'
      using errcode = '42501', detail = 'template_use_forbidden';
  end if;
  update app.message_templates
     set used_count = least(used_count + 1, 1000000000), last_used_at = now()
   where id = p_template and workspace_id = p_workspace and archived_at is null
   returning used_count into v_count;
  return v_count;
end $$;
revoke all on function private.template_used(uuid, uuid) from public;
grant execute on function private.template_used(uuid, uuid) to authenticated, service_actor;

-- ---------- grants ----------
grant select, insert, delete on app.message_templates to authenticated;
grant update (name, channel, subject, body, folder, used_count, last_used_at, archived_at, updated_at)
  on app.message_templates to authenticated;
grant select, insert, update, delete on app.message_templates to service_actor;
revoke all on app.message_templates from anon;
