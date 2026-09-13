-- =============================================================================
-- 0019 · Waitlist offers. When a 1:1 time opens on an hours calendar, the worker
--        offers it to the oldest waiting entry whose wanted window covers it, for
--        the calendar's offerMinutes. The entry keeps what it was offered
--        (`offer`: the time, its length, service and kind of place, and the
--        cancelled appointment that freed it), so the claim page shows exactly
--        that and books exactly that. Only the worker writes it: people's column
--        grants leave it out, and entries people add start without one.
-- =============================================================================

alter table app.waitlist_entries
  add column offer jsonb check (offer is null or jsonb_typeof(offer) = 'object');

drop policy waitlist_entries_insert on app.waitlist_entries;
create policy waitlist_entries_insert on app.waitlist_entries for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and created_by = (select auth.uid())
    and status = 'waiting' and offer_expires_at is null and offer is null and source <> 'booking_page');
