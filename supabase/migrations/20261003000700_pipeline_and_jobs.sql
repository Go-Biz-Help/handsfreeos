-- Automations, stage 3b: pipeline and jobs.
--
-- Nothing new is stored: which stage means what lives in workspaces.settings.automations.pipeline, and a
-- deal's moves are its own events and timeline. What changes here:
-- - five Action Center kinds: a deal in the wrong stage, a customer gone quiet after a price, a visit nobody
--   said happened (the morning after, and three days on), and a visit at the customer's place with no address;
-- - one push switch, `jobs`: "How did it go?" to whoever was on a visit, half an hour after it ends.

-- ---------- the cards ----------
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
    'job_no_address'
  ));

-- ---------- the push switch ----------
-- `jobs` is on by default, like every switch but `payment`: marking a visit done from the push is the quickest
-- way the business's records stay true.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned', 'payment', 'wallet', 'jobs') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs), each on unless false except payment: private.push_on.';
