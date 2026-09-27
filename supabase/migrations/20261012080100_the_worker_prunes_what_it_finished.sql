-- =============================================================================
-- The worker's daily sweep (webhook_deliveries.sweep) prunes what it finished.
--
--        - Handled outbox rows go after 7 days. Nothing ever removed them, so
--          the table only grew; their events stay, and failed rows are kept
--          for a person to look at. The worker's role may now delete them.
--        - The sweep removes finished jobs and outbox rows a batch at a time
--          by age; these partial indexes let it find them without reading the
--          whole table, as webhook_deliveries_finished_idx already does for
--          webhooks. The failed-outbox one also serves the health count.
-- =============================================================================

create index if not exists scheduled_jobs_finished_idx on app.scheduled_jobs (updated_at)
  where status <> 'pending';
create index if not exists outbox_finished_idx on app.outbox (updated_at) where status = 'done';
create index if not exists outbox_failed_idx on app.outbox (created_at) where status = 'failed';

grant delete on app.outbox to service_actor;
