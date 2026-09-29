-- =============================================================================
-- Texting turned down, on Home (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md
-- §6). Getting started counts the number step done once the details go to the
-- carriers, and they can refuse weeks later, when nobody is looking at the
-- guide. Owners already get an email; this lets the Action Center hold a card
-- for it too, quoting the carriers' reason, until the details are sent again
-- or approved. Nothing else changes: the card's words are written on the row,
-- as every card's are.
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
    'invoice_overdue',
    'wallet_low',
    'wallet_empty',
    'wallet_card_declined',
    'job_not_thanked',
    'referral_mentioned',
    'maintenance_due',
    'pipeline_mismatch',
    'quiet_after_price',
    'job_unconfirmed',
    'job_never_completed',
    'job_no_address',
    'client_quiet',
    'promise_due',
    'revenue_moved',
    'channel_quiet',
    'connection_error',
    'connection_silent',
    'ai_unreviewed',
    'ai_corrections',
    'website_changed',
    'faq_suggestions',
    'offer_lapsing',
    'texting_rejected'
  ));
