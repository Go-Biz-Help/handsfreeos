-- =============================================================================
-- 0022 · Agency templates. An agency (an organization) builds a workflow once
--        and pushes it to its client businesses (the organization's
--        workspaces). A template is a draft whose workspace ids (stages, tags,
--        calendars, users) are named placeholders ({"$ph": "key"}); publishing
--        freezes an append-only version; a push records one install per
--        business with its placeholder mapping, and the worker installs a draft
--        there (the system actor is bound to one workspace at a time).
--        Publishing the installed copy still needs that business's own test.
--        org.templates.manage (org owners, org admins) sees and changes all of
--        it; a business sees only its installed copy (a workflow with
--        template_id), plus the newest version number through a helper, so it
--        can show "Update available".
-- =============================================================================

create type app.template_install_status as enum ('pending', 'installed', 'failed');

-- ---------- templates: the agency's draft, with placeholders ----------
create table app.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  definition jsonb not null default '{}'::jsonb
    check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null default 1 check (definition_version >= 1),
  -- Saves carry a base revision, as with workflows.
  revision integer not null default 1 check (revision >= 1),
  -- The newest published version (null until the first publish). Installs behind it show "Update available".
  latest_version integer check (latest_version is null or latest_version >= 1),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflow_templates_org_idx on app.workflow_templates (organization_id, lower(name));
create index workflow_templates_created_by_idx on app.workflow_templates (created_by);
create trigger workflow_templates_updated_at before update on app.workflow_templates for each row execute function private.set_updated_at();
create trigger workflow_templates_immutable before update on app.workflow_templates for each row execute function private.forbid_tenant_column_change('organization_id', 'created_by');

-- ---------- template versions: append-only, like workflow versions ----------
create table app.workflow_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  template_id uuid not null references app.workflow_templates (id) on delete cascade,
  version integer not null check (version >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 524288),
  definition_version integer not null check (definition_version >= 1),
  diff_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(diff_summary) = 'array'),
  published_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);
create index workflow_template_versions_organization_id_idx on app.workflow_template_versions (organization_id);
create index workflow_template_versions_published_by_idx on app.workflow_template_versions (published_by);
create trigger workflow_template_versions_append_only before update or delete on app.workflow_template_versions
  for each row execute function private.guard_version_row('workflow_templates', 'template_id', 'organizations', 'organization_id');

-- ---------- installs: one per template and business ----------
-- A push writes (or refreshes) the row as pending with its mapping; the install job turns the template's
-- newest version into a draft there and marks it installed, or failed with the reason (an unmapped
-- placeholder, say). "Who is behind" is installed_version < the template's latest_version.
create table app.workflow_template_installs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  template_id uuid not null references app.workflow_templates (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The business's copy (workflows are archived, not deleted; set null just in case).
  workflow_id uuid references app.workflows (id) on delete set null,
  installed_version integer check (installed_version is null or installed_version >= 1),
  -- Placeholder key → what it stands for in this business (a stage, tag, calendar or user id, or a value).
  mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
  status app.template_install_status not null default 'pending',
  last_error text check (last_error is null or length(last_error) <= 2000),
  pushed_by uuid references app.users (id) on delete set null,
  pushed_at timestamptz,
  installed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, workspace_id)
);
create index workflow_template_installs_organization_id_idx on app.workflow_template_installs (organization_id);
create index workflow_template_installs_workspace_id_idx on app.workflow_template_installs (workspace_id);
create index workflow_template_installs_workflow_id_idx on app.workflow_template_installs (workflow_id);
create index workflow_template_installs_pushed_by_idx on app.workflow_template_installs (pushed_by);
create trigger workflow_template_installs_updated_at before update on app.workflow_template_installs for each row execute function private.set_updated_at();
create trigger workflow_template_installs_immutable before update on app.workflow_template_installs for each row execute function private.forbid_tenant_column_change('organization_id', 'template_id', 'workspace_id');

-- ---------- a workflow's template ----------
alter table app.workflows add constraint workflows_template_id_fkey
  foreign key (template_id) references app.workflow_templates (id) on delete set null;
create index workflows_template_id_idx on app.workflows (template_id);

-- ---------- references stay inside the organization, whoever writes ----------
-- A template reaches only its own organization's businesses.
create or replace function private.check_template_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_table_name = 'workflow_template_versions' then
    v_ok := exists (select 1 from app.workflow_templates t where t.id = new.template_id and t.organization_id = new.organization_id);
  elsif tg_table_name = 'workflow_template_installs' then
    v_ok := exists (select 1 from app.workflow_templates t where t.id = new.template_id and t.organization_id = new.organization_id)
      and private.workspace_organization(new.workspace_id) = new.organization_id
      and (new.workflow_id is null or exists (
        select 1 from app.workflows w where w.id = new.workflow_id and w.workspace_id = new.workspace_id));
  elsif tg_table_name = 'workflows' then
    v_ok := new.template_id is null or exists (
      select 1 from app.workflow_templates t
      where t.id = new.template_id and t.organization_id = private.workspace_organization(new.workspace_id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same organization' using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  return new;
end $$;
create trigger workflow_template_versions_check_refs before insert on app.workflow_template_versions
  for each row execute function private.check_template_refs();
create trigger workflow_template_installs_check_refs before insert or update of workflow_id on app.workflow_template_installs
  for each row execute function private.check_template_refs();
create trigger workflows_check_template before insert or update of template_id on app.workflows
  for each row execute function private.check_template_refs();

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('org_owner', 'org.templates.manage'), ('org_admin', 'org.templates.manage');

-- ---------- RLS: the agency's owners and admins only; the worker within its scope ----------
alter table app.workflow_templates enable row level security;
alter table app.workflow_template_versions enable row level security;
alter table app.workflow_template_installs enable row level security;

-- Templates are archived, never deleted: installed copies keep pointing at them.
create policy workflow_templates_select on app.workflow_templates for select to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'));
create policy workflow_templates_insert on app.workflow_templates for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.templates.manage') and created_by = (select auth.uid())
    and latest_version is null);
create policy workflow_templates_update on app.workflow_templates for update to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'))
  with check (private.has_org_permission(organization_id, 'org.templates.manage'));
-- An install job (scoped to a business and its organization) reads the template it installs.
create policy workflow_templates_service_all on app.workflow_templates for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy workflow_template_versions_select on app.workflow_template_versions for select to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'));
create policy workflow_template_versions_insert on app.workflow_template_versions for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.templates.manage') and published_by = (select auth.uid()));
create policy workflow_template_versions_service_all on app.workflow_template_versions for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy workflow_template_installs_select on app.workflow_template_installs for select to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'));
create policy workflow_template_installs_insert on app.workflow_template_installs for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.templates.manage') and pushed_by = (select auth.uid()));
create policy workflow_template_installs_update on app.workflow_template_installs for update to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'))
  with check (private.has_org_permission(organization_id, 'org.templates.manage'));
-- Each install job is bound to the one business it installs into.
create policy workflow_template_installs_service_all on app.workflow_template_installs for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select, insert, update on app.workflow_templates, app.workflow_template_installs to authenticated;
grant select, insert on app.workflow_template_versions to authenticated;
grant select, insert, update on app.workflow_templates, app.workflow_template_installs to service_actor;
grant select, insert on app.workflow_template_versions to service_actor;
revoke all on app.workflow_templates, app.workflow_template_versions, app.workflow_template_installs from anon;

-- ---------- "Update available" for a business ----------
-- A business can't read its agency's templates, so it gets only this: the name and newest version of each
-- template one of its workflows came from, for a workspace the caller works in. The content stays hidden.
create or replace function private.installed_template_versions(p_ws uuid)
returns table (template_id uuid, template_name text, latest_version integer)
language sql stable security definer set search_path = '' as $$
  select t.id, t.name, t.latest_version
  from app.workflow_templates t
  where p_ws in (select private.accessible_workspace_ids())
    and t.id in (select w.template_id from app.workflows w where w.workspace_id = p_ws and w.template_id is not null)
$$;

-- ---------- function privileges ----------
revoke all on function private.check_template_refs(), private.installed_template_versions(uuid) from public;
grant execute on function private.check_template_refs() to authenticated, service_actor;
grant execute on function private.installed_template_versions(uuid) to authenticated;
