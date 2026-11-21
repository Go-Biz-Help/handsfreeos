-- The networking chat after an introduction (docs/outreach.md, decision 173).
--
-- A playbook that starts with an introduction now has a networking chat
-- after it (its switches and words are kept in the playbook's details, so
-- nothing here): a question about them, one nudge if they stay quiet, and a
-- demo or a networking call offered once each, when it fits.
--
--        `follow_ups.call`: a yes in that chat was to a networking call,
--        not a demo. The ask for a time and what follows it go on the
--        person's own calendar, and a time booked from it never counts as
--        a demo.
--
-- Only adds a column with a default: the running code never reads it.

alter table addon_outreach.follow_ups
  add column if not exists call boolean not null default false;
