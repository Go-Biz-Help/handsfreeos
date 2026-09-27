-- =============================================================================
-- Who may read the history, asked once per query rather than once per row
-- (PERF-M6).
--
--        app.events and app.audit_logs asked private.has_permission(workspace_id,
--        'audit.read') on every row, and has_permission() takes the row's
--        business, so Postgres can't work it out once: filtering the audit log
--        for a rare action checked the permission on every row it passed over.
--
--        The same question turned round: *which* businesses may this person
--        read the history of. That set takes nothing from the row, so the
--        policy reads it once and each row is a lookup in it. Each function
--        below is the exact set its per-row twin is true for — the same stored
--        answer (app.workspace_access, 0106) and the same business-being-deleted
--        rule — so what anyone can see does not move.
-- =============================================================================

-- Every business where the asker holds this permission: private.has_permission(), as a set.
create or replace function private.workspaces_with_permission(p_perm text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wa.workspace_id from app.workspace_access wa
  join app.workspaces w on w.id = wa.workspace_id
  where wa.user_id = auth.uid() and p_perm = any (wa.permissions)
    and w.deletion_requested_at is null
$$;

-- Every organization where the asker's role holds this permission: private.has_org_permission(), as a set.
create or replace function private.organizations_with_permission(p_perm text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select om.organization_id from app.organization_memberships om
  where om.user_id = auth.uid()
    and exists (select 1 from app.role_permissions rp
                where rp.role = 'org_' || om.role::text and rp.permission = p_perm)
$$;

revoke all on function
  private.workspaces_with_permission(text), private.organizations_with_permission(text)
  from public;
grant execute on function
  private.workspaces_with_permission(text), private.organizations_with_permission(text)
  to authenticated, service_actor;

drop policy if exists events_select on app.events;
create policy events_select on app.events
  for select to authenticated
  using (
    actor_id = (select auth.uid())  -- you can always see what you did (also lets INSERT ... RETURNING work)
    or workspace_id in (select private.workspaces_with_permission('audit.read'))
    or (workspace_id is null
        and organization_id in (select private.organizations_with_permission('org.audit.read')))
  );

drop policy if exists audit_logs_select on app.audit_logs;
create policy audit_logs_select on app.audit_logs
  for select to authenticated
  using (
    actor_id = (select auth.uid())
    or workspace_id in (select private.workspaces_with_permission('audit.read'))
    or (workspace_id is null
        and organization_id in (select private.organizations_with_permission('org.audit.read')))
  );
