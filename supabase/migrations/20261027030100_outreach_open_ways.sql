-- The ways to start a chat (docs/outreach.md, decision 183).
--
-- A playbook now ticks the ways it may start a chat with someone new
-- (`details.ways`, kept in the playbook's details, so nothing here): Direct
-- pitch, Introduction, Value first, Trigger event, Compliment first, Ask for
-- their opinion, Social proof, Permission ask, Shared ground and Problem
-- check. For each person the AI picks the one that fits best.
--
--        `opener_uses.kind` takes each new way's name: a first message that
--        went that way, so Results counts replies and demos for each way,
--        and the conversation it starts is known (the ways that start a chat
--        go on as an introduction does).
--
-- Only widens a check: every row there now passes, and the running code
-- writes none of the new values.

alter table addon_outreach.opener_uses drop constraint opener_uses_kind_check;
alter table addon_outreach.opener_uses add constraint opener_uses_kind_check
  check (kind in ('style', 'own', 'intro', 'valueFirst', 'trigger', 'compliment',
    'opinion', 'socialProof', 'permission', 'sharedGround', 'problemCheck'));
