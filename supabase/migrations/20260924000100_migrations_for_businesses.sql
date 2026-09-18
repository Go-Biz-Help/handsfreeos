-- =============================================================================
-- 0068 · A business can move itself in, not only its agency.
--
--        Until now a migration was an agency's job: `org.migrations.manage`,
--        held by an organization's owners and admins. That was never wrong for
--        an agency, and it already covered a founder — whoever signs up gets an
--        organization of one and owns it — but it left out the case in the
--        middle, which is the common one: a business whose workspace belongs to
--        an agency's organization, whose owner is a member of the workspace and
--        not of the organization above it. That person could not start a
--        migration, and could not watch one their agency started for them.
--
--        Chris's answer (2026-09-18): either side may start it, and whoever
--        looks at it afterwards sees the same migration, with its progress, and
--        can act on it — "it should look as if they started the migration".
--        There is no second migration to create, because the screen shows the
--        one that exists; a new one only makes sense for a different source.
--
--        So the tenancy boundary moves to the **workspace**, which is the one
--        line that has to hold. `private.effective_workspace_role` already
--        flattens an agency role into every workspace of its organization, so
--        one rule serves all three readers:
--          - a founder owns their workspace, so they qualify;
--          - an agency owner inherits owner in every client workspace, so they
--            qualify everywhere they already had reach;
--          - a client's owner or admin qualifies in their own workspace only.
--
--        That last clause is the point. A client business sees and drives its
--        own part of a migration — its sub-account, its counts, its choices —
--        and never another client's, even when twenty of them share one
--        agency migration. Every policy below is row-scoped for that reason
--        rather than granting the whole migration to anyone who owns a part.
-- =============================================================================

-- ---------- the permission ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'migrations.manage'),
  ('admin', 'migrations.manage');

-- ---------- who asked for a connection ----------
-- Null when an agency connected the source (the old shape, and still the common one for a multi-business
-- migration). Set when one business connected its own, which is what lets that business claim the
-- sub-accounts the sign-in reaches without being able to reach for anybody else's.
alter table app.migration_connections
  add column workspace_id uuid references app.workspaces (id) on delete set null;

create index migration_connections_workspace_idx on app.migration_connections (workspace_id)
  where workspace_id is not null;

-- A connection's business belongs to the connection's organization.
create or replace function private.check_migration_connection_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.organizations o where o.id = new.organization_id) then
    return new;
  end if;
  if new.workspace_id is not null
     and private.workspace_organization(new.workspace_id) is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  return new;
end $$;
create trigger migration_connections_check_refs
  before insert or update of workspace_id on app.migration_connections
  for each row execute function private.check_migration_connection_refs();

-- ---------- the two questions every policy below asks ----------
-- Whether this migration reaches a business whose migrations I may manage. Used for the migration itself and
-- for the handful of rows that hang off the migration rather than off one sub-account.
create or replace function private.migration_reaches_my_workspace(p_migration uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.migration_scopes s
    where s.migration_id = p_migration and s.workspace_id is not null
      and private.has_permission(s.workspace_id, 'migrations.manage'))
$$;

-- Whether one sub-account is one I may manage: mapped to a business of mine, or not yet mapped and reached by
-- a connection my own business made. The second half is what lets a business claim its own sub-account
-- without letting it claim a sub-account the agency discovered for somebody else.
create or replace function private.migration_scope_is_mine(p_scope uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.migration_scopes s
    join app.migrations m on m.id = s.migration_id
    join app.migration_connections c on c.id = m.connection_id
    where s.id = p_scope
      and (
        (s.workspace_id is not null and private.has_permission(s.workspace_id, 'migrations.manage'))
        or (s.workspace_id is null and c.workspace_id is not null
            and private.has_permission(c.workspace_id, 'migrations.manage'))))
$$;

-- ---------- reading ----------
-- The migration, and the source behind it.
drop policy migrations_select on app.migrations;
create policy migrations_select on app.migrations for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_reaches_my_workspace(id));

drop policy migration_connections_select on app.migration_connections;
create policy migration_connections_select on app.migration_connections for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'migrations.manage'))
    or exists (select 1 from app.migrations m
               where m.connection_id = app.migration_connections.id
                 and private.migration_reaches_my_workspace(m.id)));

-- One sub-account: row-scoped, so twenty clients sharing one agency migration each see their own line and
-- nobody else's.
drop policy migration_scopes_select on app.migration_scopes;
create policy migration_scopes_select on app.migration_scopes for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(id));

-- What was found, what was chosen, and where each category got to: all per sub-account, all row-scoped.
drop policy migration_inventory_select on app.migration_inventory;
create policy migration_inventory_select on app.migration_inventory for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(scope_id));

drop policy migration_selections_select on app.migration_selections;
create policy migration_selections_select on app.migration_selections for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(scope_id));

drop policy migration_checkpoints_select on app.migration_checkpoints;
create policy migration_checkpoints_select on app.migration_checkpoints for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(scope_id));

drop policy migration_scans_select on app.migration_scans;
create policy migration_scans_select on app.migration_scans for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (scope_id is not null and private.migration_scope_is_mine(scope_id))
    or (scope_id is null and private.migration_reaches_my_workspace(migration_id)));

-- Findings, failures and customers waiting on a decision. A finding with no sub-account is about the plan as
-- a whole — "two sub-accounts will land in Lone Star HVAC" names other people's businesses — so those stay
-- the agency's.
drop policy migration_findings_select on app.migration_findings;
create policy migration_findings_select on app.migration_findings for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (scope_id is not null and private.migration_scope_is_mine(scope_id)));

drop policy migration_errors_select on app.migration_errors;
create policy migration_errors_select on app.migration_errors for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'migrations.manage')));

drop policy migration_merge_candidates_select on app.migration_merge_candidates;
create policy migration_merge_candidates_select on app.migration_merge_candidates for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.has_permission(workspace_id, 'migrations.manage'));

drop policy migration_media_select on app.migration_media;
create policy migration_media_select on app.migration_media for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.has_permission(workspace_id, 'migrations.manage'));

drop policy migration_change_journal_select on app.migration_change_journal;
create policy migration_change_journal_select on app.migration_change_journal for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.has_permission(workspace_id, 'migrations.manage'));

drop policy migration_verifications_select on app.migration_verifications;
create policy migration_verifications_select on app.migration_verifications for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (scope_id is not null and private.migration_scope_is_mine(scope_id))
    or (scope_id is null and private.migration_reaches_my_workspace(migration_id)));

-- The staged payloads stay the agency's: they are the old system's raw records, kept for support and for
-- remapping, and nothing a business needs to read to run its own move.

-- ---------- writing ----------
-- Connecting a source. Either an agency connects one, or a business connects its own and says so by naming
-- itself — a connection with no business named may only be made by somebody who runs the organization.
drop policy migration_connections_insert on app.migration_connections;
create policy migration_connections_insert on app.migration_connections for insert to authenticated
  with check (created_by = (select auth.uid())
    and status = 'pending'
    and external_account_id is null and pkce_verifier_enc is null and token_enc is null
    and token_key_id is null and token_expires_at is null and next_refresh_at is null
    and connected_at is null and disconnected_at is null and failures = 0
    and (
      (workspace_id is null and private.has_org_permission(organization_id, 'org.migrations.manage'))
      or (workspace_id is not null and private.has_permission(workspace_id, 'migrations.manage'))));

drop policy migration_connections_update on app.migration_connections;
create policy migration_connections_update on app.migration_connections for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'migrations.manage')))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'migrations.manage')));

-- Starting a migration. A business may start one on a connection it made; an agency on any of its own.
drop policy migrations_insert on app.migrations;
create policy migrations_insert on app.migrations for insert to authenticated
  with check (created_by = (select auth.uid())
    and status in ('draft', 'connected')
    and totals = '{}'::jsonb
    and started_at is null and imported_at is null and finalized_at is null and cancelled_at is null
    and transition_ends_at is null and transition_extended_count = 0
    and exists (select 1 from app.migration_connections c
                where c.id = connection_id and c.organization_id = migrations.organization_id
                  and c.status = 'active'
                  and (private.has_org_permission(c.organization_id, 'org.migrations.manage')
                    or (c.workspace_id is not null
                        and private.has_permission(c.workspace_id, 'migrations.manage')))));

drop policy migrations_update on app.migrations;
create policy migrations_update on app.migrations for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_reaches_my_workspace(id))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_reaches_my_workspace(id));

-- Saying where a sub-account lands. A business may claim one its own connection reached, or move one that is
-- already its own; it may never touch a sub-account that belongs to another business.
drop policy migration_scopes_update on app.migration_scopes;
create policy migration_scopes_update on app.migration_scopes for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(id))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (workspace_id is not null and private.has_permission(workspace_id, 'migrations.manage')));

-- Choosing what to bring, for a sub-account of mine.
drop policy migration_selections_write on app.migration_selections;
create policy migration_selections_write on app.migration_selections for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(scope_id));

drop policy migration_selections_update on app.migration_selections;
create policy migration_selections_update on app.migration_selections for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(scope_id))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.migration_scope_is_mine(scope_id));

-- Asking for a scan of a sub-account of mine.
drop policy migration_scans_insert on app.migration_scans;
create policy migration_scans_insert on app.migration_scans for insert to authenticated
  with check (requested_by = (select auth.uid())
    and status = 'scanning' and watermark_at is null and finished_at is null
    and manifest = '{}'::jsonb and estimated_bytes = 0
    and (private.has_org_permission(organization_id, 'org.migrations.manage')
      or (scope_id is not null and private.migration_scope_is_mine(scope_id))
      or (scope_id is null and private.migration_reaches_my_workspace(migration_id))));

-- Queueing the work, and retrying or stopping a batch. A business may queue work for its own sub-account, and
-- for the discovery pass of a connection it made (which has no sub-account yet to name).
drop policy migration_jobs_insert on app.migration_jobs;
create policy migration_jobs_insert on app.migration_jobs for insert to authenticated
  with check (state = 'pending' and attempts = 0 and leased_by is null and leased_until is null
    and result = '{}'::jsonb and finished_at is null
    and kind in ('discover', 'scan', 'fetch', 'import', 'verify', 'rollback')
    and (private.has_org_permission(organization_id, 'org.migrations.manage')
      or (scope_id is not null and private.migration_scope_is_mine(scope_id))
      or (scope_id is null and private.migration_reaches_my_workspace(migration_id))
      or (scope_id is null and exists (
            select 1 from app.migrations m
            join app.migration_connections c on c.id = m.connection_id
            where m.id = migration_id and c.workspace_id is not null
              and private.has_permission(c.workspace_id, 'migrations.manage')))));

drop policy migration_jobs_update on app.migration_jobs;
create policy migration_jobs_update on app.migration_jobs for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (scope_id is not null and private.migration_scope_is_mine(scope_id))
    or (scope_id is null and private.migration_reaches_my_workspace(migration_id)))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    or (scope_id is not null and private.migration_scope_is_mine(scope_id))
    or (scope_id is null and private.migration_reaches_my_workspace(migration_id)));

-- Deciding whether two customers are one person, in a business of mine.
drop policy migration_merge_candidates_update on app.migration_merge_candidates;
create policy migration_merge_candidates_update on app.migration_merge_candidates for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    or private.has_permission(workspace_id, 'migrations.manage'))
  with check ((private.has_org_permission(organization_id, 'org.migrations.manage')
      or private.has_permission(workspace_id, 'migrations.manage'))
    and resolution <> 'pending' and not auto_resolved);

-- The "two sub-accounts share a business" note is still only written and removed by whoever runs the
-- organization: it is about the plan across businesses, which is not a business's own business.

-- ---------- grants ----------
-- The new column is readable and settable by people, like the rest of a connection's own state.
grant select (workspace_id) on app.migration_connections to authenticated;
grant insert on app.migration_connections to authenticated;

-- ---------- function privileges ----------
revoke all on function private.migration_reaches_my_workspace(uuid), private.migration_scope_is_mine(uuid),
  private.check_migration_connection_refs() from public;
grant execute on function private.migration_reaches_my_workspace(uuid), private.migration_scope_is_mine(uuid),
  private.check_migration_connection_refs() to authenticated, service_actor;
