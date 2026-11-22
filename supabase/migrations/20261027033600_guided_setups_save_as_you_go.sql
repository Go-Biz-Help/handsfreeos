-- =============================================================================
-- Guided setups save as you go (the owner, 22 Nov 2026: "make sure all these
-- onboardings auto save so if they come back their choices are still there").
--        - app.guided_setup_drafts: one row for each guided setup a business
--          has started and not finished (the phone number's first, then
--          email's and the rest), holding its answers so far as its screens
--          keep them: single picks and lists of rows alike. Finishing the
--          setup, or Start over, deletes the row.
--        - Each setup belongs to the people who may change what it sets up:
--          private.guided_setup_permission names the permission, and a setup
--          it doesn't know is nobody's. A later setup is added there.
--        - Nothing here is acted on: a number is bought, and settings change,
--          only when the setup's last screen says so.
-- =============================================================================

create function private.guided_setup_permission(p_setup text)
returns text language sql immutable set search_path = '' as $$
  select case p_setup
    when 'phone' then 'channels.manage'
    when 'email' then 'channels.manage'
  end
$$;
comment on function private.guided_setup_permission(text) is
  'The permission a guided setup''s saved answers need (null: no such setup). Mirrors GUIDED_SETUPS in @hfos/core.';

create table app.guided_setup_drafts (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Which setup: 'phone', 'email'. Only the ones private.guided_setup_permission knows can be read or written.
  setup text not null check (setup ~ '^[a-z][a-z_]{1,30}$'),
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 32768),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, setup)
);
comment on table app.guided_setup_drafts is
  'A guided setup''s answers so far, saved as they are given, until the setup is finished or started over.';
create trigger guided_setup_drafts_updated_at before update on app.guided_setup_drafts
  for each row execute function private.set_updated_at();
create trigger guided_setup_drafts_immutable before update on app.guided_setup_drafts
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.guided_setup_drafts enable row level security;
create policy guided_setup_drafts_select on app.guided_setup_drafts for select to authenticated
  using (private.has_permission(workspace_id, private.guided_setup_permission(setup)));
create policy guided_setup_drafts_insert on app.guided_setup_drafts for insert to authenticated
  with check (private.has_permission(workspace_id, private.guided_setup_permission(setup)));
create policy guided_setup_drafts_update on app.guided_setup_drafts for update to authenticated
  using (private.has_permission(workspace_id, private.guided_setup_permission(setup)))
  with check (private.has_permission(workspace_id, private.guided_setup_permission(setup)));
create policy guided_setup_drafts_delete on app.guided_setup_drafts for delete to authenticated
  using (private.has_permission(workspace_id, private.guided_setup_permission(setup)));
create policy guided_setup_drafts_service_all on app.guided_setup_drafts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.guided_setup_drafts from public;
grant select, insert, update, delete on app.guided_setup_drafts to authenticated;
grant select, insert, update, delete on app.guided_setup_drafts to service_actor;
