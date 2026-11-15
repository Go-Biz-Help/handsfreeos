-- An introduction in place of the first message's question (docs/outreach.md,
-- decision 168).
--
-- A playbook can now start a chat with an introduction (`details.opens`,
-- kept in the playbook's details, so nothing here): thanks for connecting,
-- who the owner is and what the business offers, and to reach out if
-- they're ever interested. Nothing asks after it: a check-in goes once a
-- month until they write, and a yes gets the ask for a time.
--
--        `follow_ups.step` takes `intro`: a conversation an introduction
--        started, which gets check-ins and never follow-ups, even after a
--        reply that isn't a yes.
--
--        `opener_uses.kind` takes `intro`: a first message that was the
--        playbook's introduction, so Results counts it beside the first
--        message's versions, and the conversation it starts is known.
--
-- Only widens two checks: every row there now passes, and the running code
-- writes neither value.

alter table addon_outreach.follow_ups drop constraint follow_ups_step_check;
alter table addon_outreach.follow_ups add constraint follow_ups_step_check
  check (step in ('first', 'intro', 'video', 'link'));

alter table addon_outreach.opener_uses drop constraint opener_uses_kind_check;
alter table addon_outreach.opener_uses add constraint opener_uses_kind_check
  check (kind in ('style', 'own', 'intro'));
