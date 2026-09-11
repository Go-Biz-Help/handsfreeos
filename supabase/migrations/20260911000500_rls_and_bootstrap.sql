-- =============================================================================
-- 0005 · Row Level Security: helper functions, policies for every app table,
--        and the two SECURITY DEFINER bootstrap paths that create memberships
--        without `members.invite` (create_organization, accept_invitation).
--
-- Conventions
--   * Human requests run as `authenticated` with request.jwt.claims set by the
--     API for the transaction; `auth.uid()` / `auth.jwt()` work as under PostgREST.
--   * The worker runs as `service_actor` and sets app.system_scope.workspace_id /
--     app.system_scope.organization_id for the job in hand; unset scope sees nothing
--     except the outbox itself.
--   * Helpers are SECURITY DEFINER, STABLE and run with an empty search_path so
--     policies on membership tables never recurse into themselves.
-- =============================================================================

-- ---------- helpers ----------
create or replace function private.member_organization_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select om.organization_id from app.organization_memberships om where om.user_id = auth.uid()
$$;

create or replace function private.direct_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from app.workspace_memberships wm where wm.user_id = auth.uid()
$$;

create or replace function private.accessible_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from app.workspace_memberships wm where wm.user_id = auth.uid()
  union
  select w.id from app.workspaces w
  join app.organization_memberships om on om.organization_id = w.organization_id
  where om.user_id = auth.uid()
$$;

create or replace function private.accessible_organization_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select om.organization_id from app.organization_memberships om where om.user_id = auth.uid()
  union
  select w.organization_id from app.workspaces w
  join app.workspace_memberships wm on wm.workspace_id = w.id
  where wm.user_id = auth.uid()
$$;

create or replace function private.org_role(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select om.role::text from app.organization_memberships om
  where om.organization_id = p_org and om.user_id = auth.uid()
$$;

create or replace function private.effective_workspace_role(p_ws uuid)
returns text language sql stable security definer set search_path = '' as $$
  select r from (
    select wm.role::text as r from app.workspace_memberships wm
    where wm.workspace_id = p_ws and wm.user_id = auth.uid()
    union all
    select om.role::text from app.organization_memberships om
    join app.workspaces w on w.organization_id = om.organization_id
    where w.id = p_ws and om.user_id = auth.uid()
  ) roles
  order by private.role_rank(r) desc
  limit 1
$$;

create or replace function private.has_permission(p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.role_permissions rp
    where rp.role = private.effective_workspace_role(p_ws) and rp.permission = p_perm
  )
$$;

create or replace function private.has_org_permission(p_org uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.role_permissions rp
    where rp.role = 'org_' || private.org_role(p_org) and rp.permission = p_perm
  )
$$;

create or replace function private.workspace_organization(p_ws uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select w.organization_id from app.workspaces w where w.id = p_ws
$$;

create or replace function private.visible_user_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select auth.uid()
  union
  select wm.user_id from app.workspace_memberships wm
  where wm.workspace_id in (select private.accessible_workspace_ids())
  union
  select om.user_id from app.organization_memberships om
  where om.organization_id in (select private.member_organization_ids())
$$;

create or replace function private.system_scope_workspace()
returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('app.system_scope.workspace_id', true), '')::uuid
$$;

create or replace function private.system_scope_organization()
returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('app.system_scope.organization_id', true), '')::uuid
$$;

create or replace function private.system_scope_user_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.user_id from app.workspace_memberships wm
  where wm.workspace_id = private.system_scope_workspace()
  union
  select om.user_id from app.organization_memberships om
  where om.organization_id = private.system_scope_organization()
$$;

-- ---------- bootstrap: first organization + workspace for the signed-in user ----------
create or replace function private.create_organization(
  p_org_name text, p_org_slug text, p_ws_name text, p_ws_slug text,
  p_timezone text default 'America/Chicago', p_industry text default 'home_services'
) returns table (org_id uuid, ws_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_ws uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  if not exists (select 1 from app.users u where u.id = v_uid) then
    raise exception 'User profile missing' using errcode = 'P0002', detail = 'profile_missing';
  end if;
  insert into app.organizations (name, slug, created_by)
    values (btrim(p_org_name), p_org_slug, v_uid) returning id into v_org;
  insert into app.workspaces (organization_id, name, slug, timezone, industry, created_by)
    values (v_org, btrim(p_ws_name), p_ws_slug, coalesce(p_timezone, 'America/Chicago'), coalesce(p_industry, 'home_services'), v_uid)
    returning id into v_ws;
  insert into app.organization_memberships (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into app.workspace_memberships (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
  return query select v_org, v_ws;
end $$;

-- ---------- invitations: preview (masked) and accept (single use, email-bound) ----------
create or replace function private.invitation_preview(p_token_hash bytea)
returns table (
  status text, workspace_name text, organization_name text, inv_role app.member_role,
  inviter_name text, invitee_email_masked text, expires_at timestamptz, email_matches boolean
)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv app.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  select u.email::text into v_email from app.users u where u.id = v_uid;
  select * into v_inv from app.invitations i where i.token_hash = p_token_hash;
  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002', detail = 'invitation_not_found';
  end if;
  return query
    select
      case
        when v_inv.revoked_at is not null then 'revoked'
        when v_inv.accepted_at is not null then 'used'
        when v_inv.expires_at <= now() then 'expired'
        else 'pending'
      end,
      w.name, o.name, v_inv.role,
      coalesce(nullif(u.full_name, ''), u.email::text),
      left(v_inv.email::text, 1) || '••••' || substring(v_inv.email::text from '@.*$'),
      v_inv.expires_at,
      lower(v_inv.email::text) = lower(coalesce(v_email, ''))
    from app.workspaces w
    join app.organizations o on o.id = w.organization_id
    left join app.users u on u.id = v_inv.invited_by
    where w.id = v_inv.workspace_id;
end $$;

create or replace function private.accept_invitation(p_token_hash bytea)
returns table (inv_id uuid, org_id uuid, ws_id uuid, inv_role app.member_role, inv_email text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv app.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000', detail = 'not_authenticated';
  end if;
  select u.email::text into v_email from app.users u where u.id = v_uid;
  if v_email is null then
    raise exception 'User profile missing' using errcode = 'P0002', detail = 'profile_missing';
  end if;
  select * into v_inv from app.invitations i where i.token_hash = p_token_hash for update;
  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002', detail = 'invitation_not_found';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'Invitation revoked' using errcode = 'P0001', detail = 'invitation_revoked';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'Invitation already used' using errcode = 'P0001', detail = 'invitation_used';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'Invitation expired' using errcode = 'P0001', detail = 'invitation_expired';
  end if;
  if lower(v_inv.email::text) <> lower(v_email) then
    raise exception 'Invitation was sent to a different email' using errcode = 'P0001', detail = 'invitation_email_mismatch';
  end if;

  insert into app.workspace_memberships (workspace_id, user_id, role)
  values (v_inv.workspace_id, v_uid, v_inv.role)
  on conflict (workspace_id, user_id) do update
    set role = case
      when private.role_rank(excluded.role::text) > private.role_rank(app.workspace_memberships.role::text)
      then excluded.role else app.workspace_memberships.role end;

  update app.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;

  return query select v_inv.id, v_inv.organization_id, v_inv.workspace_id, v_inv.role, v_inv.email::text;
end $$;

-- ---------- function privileges ----------
revoke all on all functions in schema private from public;
grant usage on schema private to supabase_auth_admin;
grant execute on function
  private.role_rank(text),
  private.member_organization_ids(), private.direct_workspace_ids(), private.accessible_workspace_ids(), private.accessible_organization_ids(),
  private.org_role(uuid), private.effective_workspace_role(uuid),
  private.has_permission(uuid, text), private.has_org_permission(uuid, text),
  private.workspace_organization(uuid), private.visible_user_ids(),
  private.system_scope_workspace(), private.system_scope_organization(), private.system_scope_user_ids(),
  private.set_updated_at(), private.forbid_tenant_column_change(), private.forbid_change(),
  private.protect_last_org_owner(), private.protect_last_workspace_owner()
  to authenticated, service_actor;
grant execute on function private.handle_auth_user_created(), private.handle_auth_user_updated() to supabase_auth_admin;
grant execute on function
  private.create_organization(text, text, text, text, text, text),
  private.invitation_preview(bytea),
  private.accept_invitation(bytea)
  to authenticated;

-- ---------- enable RLS everywhere ----------
alter table app.organizations enable row level security;
alter table app.workspaces enable row level security;
alter table app.locations enable row level security;
alter table app.teams enable row level security;
alter table app.users enable row level security;
alter table app.organization_memberships enable row level security;
alter table app.workspace_memberships enable row level security;
alter table app.role_permissions enable row level security;
alter table app.invitations enable row level security;
alter table app.events enable row level security;
alter table app.outbox enable row level security;
alter table app.audit_logs enable row level security;

-- ---------- role_permissions ----------
create policy role_permissions_read on app.role_permissions
  for select to authenticated, service_actor using (true);

-- ---------- organizations ----------
create policy organizations_select on app.organizations
  for select to authenticated using (id in (select private.accessible_organization_ids()));
create policy organizations_update on app.organizations
  for update to authenticated
  using (private.has_org_permission(id, 'org.update'))
  with check (private.has_org_permission(id, 'org.update'));
create policy organizations_service_select on app.organizations
  for select to service_actor using (id = private.system_scope_organization());

-- ---------- workspaces ----------
-- Org members are matched on organization_id (not via this table) so INSERT ... RETURNING of a
-- brand-new workspace passes the read check inside the same statement.
create policy workspaces_select on app.workspaces
  for select to authenticated
  using (
    id in (select private.direct_workspace_ids())
    or organization_id in (select private.member_organization_ids())
  );
create policy workspaces_insert on app.workspaces
  for insert to authenticated
  with check (private.has_org_permission(organization_id, 'workspace.create') and created_by = (select auth.uid()));
create policy workspaces_update on app.workspaces
  for update to authenticated
  using (private.has_permission(id, 'workspace.update'))
  with check (private.has_permission(id, 'workspace.update'));
create policy workspaces_delete on app.workspaces
  for delete to authenticated using (private.has_permission(id, 'workspace.delete'));
create policy workspaces_service_select on app.workspaces
  for select to service_actor
  using (id = private.system_scope_workspace() or organization_id = private.system_scope_organization());

-- ---------- locations & teams (read only in Milestone 1) ----------
create policy locations_select on app.locations
  for select to authenticated using (workspace_id in (select private.accessible_workspace_ids()));
create policy teams_select on app.teams
  for select to authenticated using (workspace_id in (select private.accessible_workspace_ids()));

-- ---------- users ----------
create policy users_select on app.users
  for select to authenticated using (id in (select private.visible_user_ids()));
create policy users_update on app.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
create policy users_service_select on app.users
  for select to service_actor using (id in (select private.system_scope_user_ids()));

-- ---------- organization memberships ----------
create policy org_memberships_select on app.organization_memberships
  for select to authenticated
  using (organization_id in (select private.member_organization_ids()) or user_id = (select auth.uid()));
create policy org_memberships_update on app.organization_memberships
  for update to authenticated
  using (private.has_org_permission(organization_id, 'org.members.manage') and user_id <> (select auth.uid()))
  with check (private.has_org_permission(organization_id, 'org.members.manage') and user_id <> (select auth.uid()));
create policy org_memberships_delete on app.organization_memberships
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (private.has_org_permission(organization_id, 'org.members.manage') and user_id <> (select auth.uid()))
  );
create policy org_memberships_service_select on app.organization_memberships
  for select to service_actor using (organization_id = private.system_scope_organization());

-- ---------- workspace memberships ----------
create policy ws_memberships_select on app.workspace_memberships
  for select to authenticated using (workspace_id in (select private.accessible_workspace_ids()));
create policy ws_memberships_update on app.workspace_memberships
  for update to authenticated
  using (
    private.has_permission(workspace_id, 'members.change_role')
    and user_id <> (select auth.uid())
    and private.role_rank(role::text) <= private.role_rank(private.effective_workspace_role(workspace_id))
  )
  with check (
    private.has_permission(workspace_id, 'members.change_role')
    and user_id <> (select auth.uid())
    and private.role_rank(role::text) <= private.role_rank(private.effective_workspace_role(workspace_id))
  );
create policy ws_memberships_delete on app.workspace_memberships
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (
      private.has_permission(workspace_id, 'members.remove')
      and private.role_rank(role::text) <= private.role_rank(private.effective_workspace_role(workspace_id))
    )
  );
create policy ws_memberships_service_select on app.workspace_memberships
  for select to service_actor using (workspace_id = private.system_scope_workspace());

-- ---------- invitations ----------
create policy invitations_select on app.invitations
  for select to authenticated
  using (
    private.has_permission(workspace_id, 'invitations.read')
    or email::text = lower(coalesce((select auth.jwt() ->> 'email'), ''))
  );
create policy invitations_insert on app.invitations
  for insert to authenticated
  with check (
    private.has_permission(workspace_id, 'members.invite')
    and invited_by = (select auth.uid())
    and organization_id = private.workspace_organization(workspace_id)
    and private.role_rank(role::text) <= private.role_rank(private.effective_workspace_role(workspace_id))
    -- the worker mints the token; nobody pre-accepts or pre-revokes
    and token_hash is null and sent_at is null
    and accepted_at is null and accepted_by is null
    and revoked_at is null and revoked_by is null
  );
create policy invitations_update on app.invitations
  for update to authenticated
  using (private.has_permission(workspace_id, 'invitations.revoke'))
  with check (private.has_permission(workspace_id, 'invitations.revoke'));
create policy invitations_service_select on app.invitations
  for select to service_actor using (workspace_id = private.system_scope_workspace());
create policy invitations_service_update on app.invitations
  for update to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- events ----------
create policy events_select on app.events
  for select to authenticated
  using (
    actor_id = (select auth.uid())  -- you can always see what you did (also lets INSERT ... RETURNING work)
    or (workspace_id is not null and private.has_permission(workspace_id, 'audit.read'))
    or (workspace_id is null and organization_id is not null and private.has_org_permission(organization_id, 'org.audit.read'))
  );
create policy events_insert on app.events
  for insert to authenticated
  with check (
    actor_type = 'human' and actor_id = (select auth.uid())
    and (organization_id is null or organization_id in (select private.accessible_organization_ids()))
    and (workspace_id is null or workspace_id in (select private.accessible_workspace_ids()))
  );
create policy events_service_select on app.events
  for select to service_actor
  using (workspace_id = private.system_scope_workspace() or organization_id = private.system_scope_organization());
create policy events_service_insert on app.events
  for insert to service_actor
  with check (
    actor_type <> 'human'
    and (workspace_id = private.system_scope_workspace() or organization_id = private.system_scope_organization())
  );

-- ---------- outbox ----------
create policy outbox_insert on app.outbox
  for insert to authenticated
  with check (organization_id is null or organization_id in (select private.accessible_organization_ids()));
create policy outbox_service_all on app.outbox
  for all to service_actor using (true) with check (true);

-- ---------- audit_logs ----------
create policy audit_logs_select on app.audit_logs
  for select to authenticated
  using (
    actor_id = (select auth.uid())
    or (workspace_id is not null and private.has_permission(workspace_id, 'audit.read'))
    or (workspace_id is null and organization_id is not null and private.has_org_permission(organization_id, 'org.audit.read'))
  );
create policy audit_logs_insert on app.audit_logs
  for insert to authenticated
  with check (
    actor_type = 'human' and actor_id = (select auth.uid())
    and (organization_id is null or organization_id in (select private.accessible_organization_ids()))
    and (workspace_id is null or workspace_id in (select private.accessible_workspace_ids()))
  );
create policy audit_logs_service_select on app.audit_logs
  for select to service_actor
  using (workspace_id = private.system_scope_workspace() or organization_id = private.system_scope_organization());
create policy audit_logs_service_insert on app.audit_logs
  for insert to service_actor
  with check (
    actor_type <> 'human'
    and (workspace_id = private.system_scope_workspace() or organization_id = private.system_scope_organization())
  );
