-- =============================================================================
-- An outbox row says what its event says.
--
--        The worker takes a job's tenant from `app.outbox` — its
--        organization_id, workspace_id and event_type — not from the event it
--        points at. `outbox_insert` only asked that the organization was one
--        of mine, so at the database level a person could queue their own
--        event under another business's workspace and the worker would run it
--        there. The kernel always writes the three rows from the same values
--        (recordEvent in packages/core/src/kernel/execute.ts), so nothing
--        reaches this today; it is the backstop the policies are for.
--
--        So the outbox row must name an event this person just recorded, with
--        the same tenant and type, and an event or audit row that names a
--        workspace must name that workspace's own organization.
-- =============================================================================

drop policy if exists events_insert on app.events;
create policy events_insert on app.events
  for insert to authenticated
  with check (
    actor_type = 'human' and actor_id = (select auth.uid())
    and (organization_id is null or organization_id in (select private.accessible_organization_ids()))
    and (workspace_id is null or workspace_id in (select private.accessible_workspace_ids()))
    and (workspace_id is null or private.workspace_organization(workspace_id) = organization_id)
  );

drop policy if exists outbox_insert on app.outbox;
create policy outbox_insert on app.outbox
  for insert to authenticated
  with check (exists (
    select 1 from app.events e
    where e.id = outbox.event_id
      and e.actor_type = 'human' and e.actor_id = (select auth.uid())
      and e.organization_id is not distinct from outbox.organization_id
      and e.workspace_id is not distinct from outbox.workspace_id
      and e.event_type = outbox.event_type));

drop policy if exists audit_logs_insert on app.audit_logs;
create policy audit_logs_insert on app.audit_logs
  for insert to authenticated
  with check (
    actor_type = 'human' and actor_id = (select auth.uid())
    and (organization_id is null or organization_id in (select private.accessible_organization_ids()))
    and (workspace_id is null or workspace_id in (select private.accessible_workspace_ids()))
    and (workspace_id is null or private.workspace_organization(workspace_id) = organization_id)
  );
