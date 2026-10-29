-- =============================================================================
-- After a demo is booked (docs/outreach.md, decision 106).
--
-- The owner's decision (settled):
--
--        Also a short reminder in the social chat the day before. After a
--        no-show, the AI drafts "want to pick another time?" in the chat,
--        and it waits for your OK. After the demo, the lead moves on and you
--        mark it won or lost.
--
-- `app.leads.won_by_hand`: a deal a person marks won or lost themselves.
-- Automations' "Move deals along for you" never takes its done visit for a
-- win (core's `lead.wait_for_outcome`); a quote accepted still counts.
--
-- `addon_outreach.sends.kind` takes Social Outreach's two new messages: the
-- reminder the day before (`demo_reminder`) and another time after a no-show
-- (`rebook`).
--
-- Only adds: a column with its default, and a check that lets two more kinds.
-- =============================================================================

alter table app.leads add column won_by_hand boolean not null default false;

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in',
    'partner_ask', 'partner_follow_up', 'partner_details', 'partner_reply', 'comment',
    'demo_reminder', 'rebook'));
