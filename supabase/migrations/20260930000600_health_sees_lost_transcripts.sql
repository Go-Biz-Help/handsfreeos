-- /admin → Health counts calls whose words never arrived.
--
-- A recording that failed to transcribe left no trace anywhere an operator looks: the job finished (it settled the
-- call as `failed`, which is the right thing to do), so it is not a failed job, and nothing else counted it. The
-- only way to notice was a customer saying a voicemail had no words — which is how this was found.
--
-- `lost_transcripts` counts calls settled `failed` in the window. A single one is ordinary: a caller who hung up on
-- the greeting leaves a second of silence with nothing in it. A rising number is the transcriber refusing the work,
-- a key that has stopped working, or recordings never reaching our storage.

create or replace function private.admin_health_counts(p_since timestamptz)
returns table (
  failed_jobs bigint, failed_deliveries bigint, email_bounces bigint, failed_texts bigint,
  payment_failures bigint, lost_transcripts bigint, outbox_backlog bigint, oldest_pending_minutes int)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.scheduled_jobs j where j.status = 'failed' and j.updated_at > p_since),
    (select count(*) from app.webhook_deliveries d where d.status = 'failed' and d.updated_at > p_since),
    (select count(*) from app.email_suppressions s
      where s.created_at > p_since and s.released_at is null and s.reason <> 'manual'),
    (select count(*) from app.messages m
      where m.channel = 'sms' and m.status = 'failed' and m.updated_at > p_since),
    (select count(*) from app.payments p where p.status = 'failed' and p.updated_at > p_since),
    (select count(*) from app.calls c where c.transcript_status = 'failed' and c.updated_at > p_since),
    (select count(*) from app.outbox o where o.status in ('pending', 'failed')),
    (select coalesce(max(extract(epoch from (now() - o.created_at)) / 60), 0)::int from app.outbox o
      where o.status = 'pending')
  where private.staff_can('platform.health.read')
$$;
