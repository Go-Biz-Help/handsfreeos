-- =============================================================================
-- 0073 · Telling a business its balance is running out.
--
--        Seventh of the wallet's ten steps (M16). Three cards in the Action
--        Center, one push switch, and the attention subject that lets a
--        business's own wallet be the thing a card is about.
--
--        These three are unlike every other kind: they are not about a
--        customer. No lead, no person, no conversation, and no money in Home's
--        "$ affected" — that number is what customers owe, and a wallet is the
--        other direction entirely.
--
--        Two of them cannot be dismissed, which is a decision rather than an
--        oversight: a business that cannot send a text is not helped by hiding
--        the card that says so. The permission map in core says the same.
--
--        The names must match core's ATTENTION_KINDS exactly; a DB parity test
--        (packages/db/test/parity.test.ts) compares the two.
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
    'wallet_card_declined'
  ));

-- The subject of a wallet card is the business itself, so `subject_id` is the workspace's own id. That is why
-- these three carry no foreign key of their own and why there is never more than one of each.
comment on column app.attention_items.subject_id is
  'The row the card is about: a lead, an attendee, an approval, a conversation, a task, an estimate, an '
  'invoice — or, for the wallet''s three kinds, the workspace''s own id, because a business has one wallet.';

-- ---------- the push switch ----------
-- `wallet` is **on by default**, like every switch but `payment`. A failed payment is a thing to look at when
-- you next look; a balance that has run out stops the business working, and somebody has to know now.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned', 'payment', 'wallet') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet), each on unless false except payment: private.push_on.';
