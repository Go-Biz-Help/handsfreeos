-- Retry, and Retry all, on messages and comments the extension couldn't send (docs/outreach.md decision 133): each
-- goes again as a new send, OK'd as it was, no sooner than `not_before`, a few minutes after the one before, so they
-- never all go at once. Null for every other send: it goes when its turn comes.
alter table addon_outreach.sends add column not_before timestamptz;
