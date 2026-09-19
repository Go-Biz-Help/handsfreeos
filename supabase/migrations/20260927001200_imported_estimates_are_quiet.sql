-- =============================================================================
-- An estimate brought from another CRM is quiet too.
--
--        Chris's call about imported bills (2026-09-19) was that HandsFreeOS
--        never chases them: the old system is still sending its own reminders
--        about the same money while the history catches up, and being chased
--        twice about one bill is what a customer remembers. Invoices carry that
--        mark in `reminder_state`, which they already had.
--
--        Estimates had nowhere to carry it, and they are chased in exactly the
--        same way — the nudge a few days after it went out, and the warning
--        before it expires, both of which are messages to the customer. So they
--        get the same column, for the same reason, read by the same arming code.
--
--        Nothing else changes: an estimate still expires, still shows as out,
--        and still reaches whoever is looking at the pipeline. Only the
--        messages stop.
-- =============================================================================

alter table app.estimates
  add column reminder_state jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reminder_state) = 'object' and pg_column_size(reminder_state) <= 16384);

comment on column app.estimates.reminder_state is
  'The worker''s: which nudges have gone out, and whether this estimate came from another system and is '
  'therefore never chased from here (imported = quiet).';
