-- =============================================================================
-- A wait for a session ends when the session starts, or when it's cancelled.
--
--        Someone waiting for a seat in a full session stayed `waiting` after the
--        session had started, or been called off, so they still showed on the
--        waitlist, the appointment and in the Assistant. The worker now arms the
--        same job a wait for a window of time gets (waitlist.window_end, due
--        when the session starts, or at once when it's cancelled), which marks
--        the entry expired through waitlist.expire. Nobody is told. This arms
--        it, with the same kind and key, for everyone already waiting for a
--        session: one that has started or was cancelled runs straight away.
-- =============================================================================

insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
select w.organization_id, e.workspace_id, 'waitlist.window_end', 'waitlist-window:' || e.id::text,
       case when a.status = 'scheduled' then a.starts_at else now() end, jsonb_build_object('entryId', e.id)
from app.waitlist_entries e
join app.appointments a on a.id = e.appointment_id
join app.workspaces w on w.id = e.workspace_id
where e.status = 'waiting'
on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
