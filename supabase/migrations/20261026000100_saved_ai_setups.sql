-- Quick setup for the AI teammate, agencies (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §9): an agency
-- saves the answers one client business gave as a starting point for its others (the owner's 58B). Only the
-- answers that aren't about one business are kept (core's AI_SETUP_TEMPLATE_FIELDS: the jobs, when the teammate
-- answers, its name, how it says it's AI, its tone, prices and the questions for leads).
--
-- The agency's owners and admins (org.templates.manage) save, rename and remove them. Whoever sets up the AI
-- teammate in one of the organization's businesses (ai_team.manage there) reads them, to start quick setup from
-- one. Nothing else changes: a business keeps the answers it was set up with, whatever happens to these later.

create table app.ai_setup_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- The kind of business they were saved from (core's SetupKind): a business of the same kind starts from them.
  kind text not null check (length(kind) between 1 and 40),
  -- core's AiSetupTemplate, read forgivingly: an answer that no longer reads is today's pick.
  answers jsonb not null check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 65536),
  -- The business they were saved from, shown in the agency area.
  from_workspace_id uuid references app.workspaces (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One name once in an agency, whatever its case or spaces around it.
create unique index ai_setup_templates_name_key on app.ai_setup_templates (organization_id, lower(btrim(name)));
create index ai_setup_templates_from_workspace_idx on app.ai_setup_templates (from_workspace_id);
create index ai_setup_templates_created_by_idx on app.ai_setup_templates (created_by);
create index ai_setup_templates_updated_by_idx on app.ai_setup_templates (updated_by);
create trigger ai_setup_templates_updated_at before update on app.ai_setup_templates
  for each row execute function private.set_updated_at();
create trigger ai_setup_templates_immutable before update on app.ai_setup_templates
  for each row execute function private.forbid_tenant_column_change('organization_id', 'created_by');

-- Whoever sets up the AI teammate in one of the organization's businesses, the founder's open business included.
create or replace function private.sets_up_ai_in_organization(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.accessible_workspace_ids() a (id)
    join app.workspaces w on w.id = a.id
    where w.organization_id = p_org and private.has_permission(w.id, 'ai_team.manage')
  )
$$;
revoke all on function private.sets_up_ai_in_organization(uuid) from public;
grant execute on function private.sets_up_ai_in_organization(uuid) to authenticated;

alter table app.ai_setup_templates enable row level security;

create policy ai_setup_templates_select on app.ai_setup_templates for select to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage')
    or private.sets_up_ai_in_organization(organization_id));
create policy ai_setup_templates_insert on app.ai_setup_templates for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.templates.manage')
    and created_by = (select auth.uid()) and updated_by = (select auth.uid()));
create policy ai_setup_templates_update on app.ai_setup_templates for update to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'))
  with check (private.has_org_permission(organization_id, 'org.templates.manage')
    and updated_by = (select auth.uid()));
create policy ai_setup_templates_delete on app.ai_setup_templates for delete to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'));

grant select, insert, delete on app.ai_setup_templates to authenticated;
grant update (name, kind, answers, from_workspace_id, updated_by) on app.ai_setup_templates to authenticated;
revoke all on app.ai_setup_templates from anon;
