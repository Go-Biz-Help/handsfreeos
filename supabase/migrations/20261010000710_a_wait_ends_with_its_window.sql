-- =============================================================================
-- A wait for a window of time ends with the window.
--
--        Someone waiting for "any time Friday morning" stayed `waiting` long
--        after Friday, so they piled up on the calendar's waitlist. The worker
--        now arms a job for each new one (waitlist.window_end, due when the
--        window ends), which marks the entry expired through waitlist.expire.
--        Nobody is told. This arms the same job, with the same kind and key,
--        for everyone already waiting for a window: one whose window has
--        passed runs straight away.
-- =============================================================================

insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
select w.organization_id, e.workspace_id, 'waitlist.window_end', 'waitlist-window:' || e.id::text,
       e.wanted_to, jsonb_build_object('entryId', e.id)
from app.waitlist_entries e
join app.workspaces w on w.id = e.workspace_id
where e.appointment_id is null and e.wanted_to is not null and e.status in ('waiting', 'offered')
on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
