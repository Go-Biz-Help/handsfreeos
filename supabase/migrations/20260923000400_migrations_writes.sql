-- =============================================================================
-- 0067 · What a person may write while running a migration.
--
--        0064 granted `authenticated` nothing but SELECT, which was right for
--        the counts and the findings — nobody should be able to type a count
--        into their own report — but the wizard itself is a person clicking
--        buttons, and its commands run as that person under RLS like every
--        other command here. So this opens exactly the doors the wizard needs
--        and no more, column by column, in the same style as the payment
--        accounts in 0046:
--
--          migrations            start one, and move it between its states.
--          migration_scopes      say where a sub-account lands.
--          migration_scans       ask for a scan.
--          migration_selections  choose what to bring.
--          migration_findings    acknowledge one, and replace the "these two
--                                sub-accounts share a business" note when the
--                                mapping changes.
--          migration_jobs        queue the work, retry it, cancel it.
--          migration_merge_cand. decide whether two people are one person.
--
--        Everything the old system tells us — the inventory, the checkpoints,
--        the staged payloads, the mappings, the journal, the media, the
--        verifications — stays the worker's alone. A browser can ask for work
--        to be done; it can never write down the answer.
-- =============================================================================

-- ---------- the migration itself ----------
-- Starting one: connected to a live source in this organization, by the person starting it, with no
-- progress, no dates and no totals invented on the way in.
create policy migrations_insert on app.migrations for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    and created_by = (select auth.uid())
    and status in ('draft', 'connected')
    and totals = '{}'::jsonb
    and started_at is null and imported_at is null and finalized_at is null and cancelled_at is null
    and transition_ends_at is null and transition_extended_count = 0
    and exists (select 1 from app.migration_connections c
                where c.id = connection_id and c.organization_id = migrations.organization_id
                  and c.status = 'active'));
create policy migrations_update on app.migrations for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));

-- Which state a person may ask for. Everything else — imported, completed, rolled_back, needs_attention —
-- is the engine's answer about what actually happened, and a browser may not simply declare it.
create or replace function private.guard_migration_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_organization() = new.organization_id, false) then
    return new;
  end if;
  if new.status is distinct from old.status
     and new.status not in ('scanning', 'ready', 'importing', 'paused', 'finalizing', 'cancelling',
                            'rolling_back', 'transition') then
    raise exception 'A migration reaches that state on its own'
      using errcode = '42501', detail = 'migration_status_transition';
  end if;
  -- Counts and dates are what happened, not what somebody typed.
  if new.totals is distinct from old.totals
     or new.imported_at is distinct from old.imported_at
     or new.finalized_at is distinct from old.finalized_at then
    raise exception 'Only the engine writes a migration’s progress'
      using errcode = '42501', detail = 'migration_progress_readonly';
  end if;
  return new;
end $$;
create trigger migrations_update_guard before update on app.migrations for each row
  execute function private.guard_migration_update();

grant insert on app.migrations to authenticated;
grant update (status, name, transition_enabled, transition_ends_at, transition_extended_count,
  include_deleted, started_at, cancelled_at, last_error) on app.migrations to authenticated;

-- ---------- where each sub-account lands ----------
-- Discovered by the scan; a person only ever says where one goes, or that it is skipped.
create policy migration_scopes_update on app.migration_scopes for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));

create or replace function private.guard_migration_scope_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_organization() = new.organization_id, false) then
    return new;
  end if;
  if new.status is distinct from old.status
     and new.status not in ('skipped', 'mapped', 'importing', 'paused') then
    raise exception 'A business reaches that state on its own'
      using errcode = '42501', detail = 'migration_scope_status_transition';
  end if;
  if new.totals is distinct from old.totals or new.scanned_at is distinct from old.scanned_at
     or new.imported_at is distinct from old.imported_at then
    raise exception 'Only the engine writes a business’s progress'
      using errcode = '42501', detail = 'migration_scope_progress_readonly';
  end if;
  return new;
end $$;
create trigger migration_scopes_update_guard before update on app.migration_scopes for each row
  execute function private.guard_migration_scope_update();

grant update (workspace_id, creates_workspace, selected, status, started_at)
  on app.migration_scopes to authenticated;

-- ---------- asking for a scan ----------
-- Read-only work, so a person may queue it; its answers are written by the worker.
create policy migration_scans_insert on app.migration_scans for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    and requested_by = (select auth.uid())
    and status = 'scanning' and watermark_at is null and finished_at is null
    and manifest = '{}'::jsonb and estimated_bytes = 0);
grant insert on app.migration_scans to authenticated;

-- ---------- choosing what to bring ----------
create policy migration_selections_write on app.migration_selections for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_selections_update on app.migration_selections for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));
grant insert on app.migration_selections to authenticated;
grant update (selected, auto_added, required_by, chosen_by) on app.migration_selections to authenticated;

-- ---------- findings ----------
-- A person acknowledges one. The "two sub-accounts share a business" note is rewritten whenever the mapping
-- changes, so that one code — and only that one — may also be inserted and removed from the wizard.
create policy migration_findings_insert on app.migration_findings for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    and code = 'plan.scopes_share_workspace' and not blocks_import);
create policy migration_findings_update on app.migration_findings for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_findings_delete on app.migration_findings for delete to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage')
    and code = 'plan.scopes_share_workspace');
grant insert on app.migration_findings to authenticated;
grant update (acknowledged_at, acknowledged_by) on app.migration_findings to authenticated;
grant delete on app.migration_findings to authenticated;

-- ---------- queueing the work ----------
-- A browser may ask for work to be done; what it may ask for is a fixed, inert list, and everything the job
-- then reports about itself is the worker's.
create policy migration_jobs_insert on app.migration_jobs for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    and state = 'pending' and attempts = 0 and leased_by is null and leased_until is null
    and result = '{}'::jsonb and finished_at is null
    and kind in ('discover', 'scan', 'fetch', 'import', 'verify', 'rollback'));
create policy migration_jobs_update on app.migration_jobs for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));

-- The only moves a person makes on a batch: try it again, or stop it.
--
-- The worker claims batches across every organization at once, so it holds no organization scope while it
-- does — which is why this asks which role is running rather than which tenant is set. `role` is a setting
-- that SECURITY DEFINER does not change, so it still says `service_actor` inside this trigger.
create or replace function private.guard_migration_job_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') = 'service_actor'
     or coalesce(private.system_scope_organization() = new.organization_id, false) then
    return new;
  end if;
  if new.state not in ('retry', 'pending', 'cancelled') then
    raise exception 'People can only retry or stop a batch'
      using errcode = '42501', detail = 'migration_job_state_transition';
  end if;
  if new.result is distinct from old.result or new.input is distinct from old.input then
    raise exception 'Only the engine writes what a batch did'
      using errcode = '42501', detail = 'migration_job_result_readonly';
  end if;
  return new;
end $$;
create trigger migration_jobs_update_guard before update on app.migration_jobs for each row
  execute function private.guard_migration_job_update();

grant insert on app.migration_jobs to authenticated;
grant update (state, run_at, last_error, leased_by, leased_until, finished_at)
  on app.migration_jobs to authenticated;

-- ---------- deciding whether two people are one person ----------
create policy migration_merge_candidates_update on app.migration_merge_candidates for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    and resolution <> 'pending' and not auto_resolved);
grant update (resolution, target_id, resolved_at, resolved_by, auto_resolved)
  on app.migration_merge_candidates to authenticated;

-- ---------- function privileges ----------
revoke all on function private.guard_migration_update(), private.guard_migration_scope_update(),
  private.guard_migration_job_update() from public;
grant execute on function private.guard_migration_update(), private.guard_migration_scope_update(),
  private.guard_migration_job_update() to authenticated, service_actor;
