-- =============================================================================
-- 0049 · The two money kinds Milestone 8 left unbuilt: an estimate nobody
--        answered and an invoice nobody paid. They are one line each in the
--        check constraint 0039 wrote them a comment for. Both are ask-first
--        only — money never chases itself — and both count in Home's
--        "$ affected": an overdue invoice is money owed, an estimate stays out
--        of the number until it is accepted.
--        The names must match core's ATTENTION_KINDS exactly; a DB parity test
--        (packages/db/test/parity.test.ts) compares the two.
--        Money settings need no table of their own: they live in
--        app.workspaces.settings under 'money', with their own command, beside
--        the calendar's and the AI teammate's.
-- =============================================================================

alter table app.attention_items
  drop constraint attention_items_kind_check,
  add constraint attention_items_kind_check check (kind in (
    'hot_lead',
    'unanswered_lead',
    'stale_opportunity',
    'missing_next_action',
    'unconfirmed_appointment',
    'ai_approval',
    'customer_waiting',
    'overdue_task',
    'estimate_waiting',
    'invoice_overdue'
  ));
