-- =============================================================================
-- 0051 · What the card was, on the payment row: "Visa" and "4242". A receipt
--        that says only "Paid $180.00 · card" leaves a customer checking their
--        statement to work out which card they used, and it is the one thing
--        both providers hand back for free on every card payment (Stripe's
--        payment_method_details.card, Square's card_details.card).
--        Never the number and never anything else off the card — the provider
--        holds that, and holding it here is what would drag us out of the
--        lightest PCI bracket. Nullable everywhere: a bank transfer, cash and
--        a cheque have no brand and no last four, and a provider that doesn't
--        say leaves them null rather than being guessed at.
--        Both stay the worker's, like every other thing a provider decides:
--        the insert policy for people already refuses anything but cash, a
--        cheque or "other", and it now refuses these two as well.
-- =============================================================================

alter table app.payments
  add column card_brand text
    check (card_brand is null or length(btrim(card_brand)) between 1 and 40),
  add column card_last4 text
    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');

-- Only a card has either, and neither is any use without the other.
alter table app.payments
  add constraint payments_card_details_check
    check ((card_brand is null and card_last4 is null) or method = 'card');

comment on column app.payments.card_brand is
  'What the provider called the card ("Visa"); null for anything that was not a card.';
comment on column app.payments.card_last4 is
  'The last four digits the provider gave. Never the number itself.';

-- A person records cash, a cheque or something taken off the system, in their own name — and now, explicitly,
-- without a card brand or last four, which only a provider can honestly say.
drop policy payments_insert on app.payments;
create policy payments_insert on app.payments for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and method in ('cash', 'check', 'other')
    and status = 'succeeded' and provider is null and connection_id is null and provider_payment_id is null
    and provider_status is null and fee_cents is null and net_cents is null
    and card_brand is null and card_last4 is null
    and recorded_by = (select auth.uid()));
