-- Messages written again under new rules (docs/outreach.md, decision 157).
--
-- The AI never mentions a group the owner and the person are both in any
-- more, so a message drafted before that, still waiting for an OK or OK'd
-- and not yet sent, is written again. Each message the extension queues now
-- keeps the version of the rules it was drafted under; the API's
-- `RULES_VERSION` says which is current. One drafted under older rules is
-- passed over by Today and the lists, and goes when the person's extension
-- next queues a message, so Today lists them again and it's drafted afresh.
--
--        `sends.rules_version` is the version of the AI's rules the message
--        was drafted under: 0 for every message drafted before this.
--
--        The person may now delete their own message OK'd and not yet sent,
--        as well as one waiting for their OK (decision 134's policy). What was
--        sent, skipped or not sent still stays.
--
-- Adds a column, and swaps one delete policy for a wider one. The running
-- code deletes only messages waiting for an OK, as before.

alter table addon_outreach.sends
  add column rules_version integer not null default 0;

comment on column addon_outreach.sends.rules_version is
  'The version of the AI''s rules it was drafted under: one drafted under older rules, still waiting or OK''d, is written again (decision 157).';

drop policy sends_own_waiting_delete on addon_outreach.sends;
create policy sends_own_open_delete on addon_outreach.sends as restrictive for delete to authenticated
  using (user_id = (select auth.uid()) and state in ('waiting', 'approved'));
