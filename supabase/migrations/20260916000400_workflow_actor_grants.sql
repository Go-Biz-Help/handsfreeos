-- =============================================================================
-- 0024 · What workflow steps may write. A step runs the same commands people
--        use, as the system (service_actor, bound to the run's workspace),
--        recorded as actor_type 'workflow'. The worker could already write
--        most of what those commands touch:
--          people and conversations (0007, 0011: the whole row),
--          messages and opt-outs (0011),
--          activities it authors (0007: insert, never as 'human'; 0011: update),
--          tags and record tags (0010: insert; record tags also delete),
--          and new leads (0016).
--        This adds the rest: creating, updating and completing tasks, and
--        updating leads (stage moves, next actions, fields). Deleting either
--        stays with people. Inbound workflow webhooks are stored like every
--        provider's, under the new provider 'workflow'.
-- =============================================================================

-- ---------- tasks: task.create and task.complete ----------
create policy tasks_service_insert on app.tasks for insert to service_actor
  with check (workspace_id = private.system_scope_workspace());
create policy tasks_service_update on app.tasks for update to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant insert, update on app.tasks to service_actor;

-- ---------- leads: lead.update, lead.move_stage, lead.set_next_action (and person.update's lead touch) ----------
-- private.sync_lead_status still checks the stage, pipeline and lost reason; private.guard_archive already
-- lets the system archive in its own workspace.
create policy leads_service_update on app.leads for update to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant update on app.leads to service_actor;

-- ---------- inbound workflow webhooks ----------
alter table app.webhook_deliveries
  drop constraint webhook_deliveries_provider_check,
  add constraint webhook_deliveries_provider_check
    check (provider in ('twilio', 'postmark', 'microsoft', 'google', 'fake', 'workflow'));
