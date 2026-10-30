-- =============================================================================
-- Social Outreach: the AI decides the friend requests the person gets
-- (docs/outreach.md, decision 136).
--
-- The owner's decision (settled, "1a 2a 3a 4a 5c"):
--
--        Every request the person gets has its profile read by the AI first,
--        against the playbooks, the mutual friends and where they live. It
--        answers Confirm (a likely customer or partner, or a real person
--        with 10 or more mutual friends who isn't a clear no), Delete, or
--        Not sure. Not sure waits for the person, with Confirm and Delete
--        buttons beside Leave it. On Facebook, LinkedIn and Alignable.
--
-- The check of someone who asked says so (`checks.via` takes `request`), and
-- keeps the AI's answer beside its usual read (`request_answer`, with its
-- one line of why), so the verdict still says only whether they'd be a
-- customer. The person's own Confirm or Delete on a request is kept on it
-- (`friends.answer`, at `answer_at`): it counts while it's since `since`, so
-- one they send again later starts afresh.
--
-- Only adds: two columns on each table nobody has to fill, and a check that
-- lets one more kind.
-- =============================================================================

alter table addon_outreach.checks drop constraint checks_via_check;
alter table addon_outreach.checks add constraint checks_via_check
  check (via in ('known', 'found', 'follower', 'member', 'request'));

alter table addon_outreach.checks
  add column request_answer text check (request_answer in ('confirm', 'delete', 'ask')),
  add column request_why text check (char_length(request_why) <= 200);

comment on column addon_outreach.checks.request_answer is
  'What the AI says to do with a friend request this person sent (decision 136): confirm, delete, or ask the person.';
comment on column addon_outreach.checks.request_why is
  'Why, in one line a person reads in a list (decision 136).';

alter table addon_outreach.friends
  add column answer text check (answer in ('confirm', 'delete')),
  add column answer_at timestamptz;

comment on column addon_outreach.friends.answer is
  'The person''s Confirm or Delete on a request they got (decision 136): the extension does it. Counts while `answer_at >= since`.';
comment on column addon_outreach.friends.answer_at is
  'When the person pressed Confirm or Delete on this request (decision 136).';
