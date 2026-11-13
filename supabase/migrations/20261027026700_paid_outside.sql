-- =============================================================================
-- Invoices paid outside Stripe or Square, b (/mnt/project-files/manual-invoices).
--
-- * An invoice can be kept off every connected account (`pay_outside`): the
--   customer's page shows no Pay button, and the texts say "See it here". It
--   is never paid into an account, so it has none.
-- * A payment taken by hand keeps where it went through ("Chase QuickAccept",
--   "Zelle") and a note. Both were typed before and thrown away.
-- * "Card (other machine)" is taken by hand like cash: no provider, nothing
--   to confirm later. Both insert policies a person writes through name it.
-- =============================================================================

alter table app.invoices
  add column pay_outside boolean not null default false,
  add constraint invoices_pay_outside_no_account check (not pay_outside or connection_id is null);

alter table app.payments
  add column paid_through text
    check (paid_through is null or length(btrim(paid_through)) between 1 and 80),
  add column note text
    check (note is null or length(btrim(note)) between 1 and 500);

-- What a person takes by hand never has a provider, and what a provider takes always has one.
alter table app.payments drop constraint payments_check;
alter table app.payments add constraint payments_by_hand_has_no_provider
  check ((provider is null) = (method in ('cash', 'check', 'other', 'card_outside')));

drop policy payments_bill_insert on app.payments;
create policy payments_bill_insert on app.payments for insert to authenticated
  with check (private.money_biller(workspace_id) and private.money_invoice_visible(workspace_id, invoice_id)
    and method in ('cash', 'check', 'other', 'card_outside')
    and status = 'succeeded' and provider is null and connection_id is null and provider_payment_id is null
    and provider_status is null and fee_cents is null and net_cents is null
    and card_brand is null and card_last4 is null
    and recorded_by = (select auth.uid()));

drop policy payments_insert on app.payments;
create policy payments_insert on app.payments for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and method in ('cash', 'check', 'other', 'card_outside')
    and status = 'succeeded' and provider is null and connection_id is null and provider_payment_id is null
    and provider_status is null and fee_cents is null and net_cents is null
    and card_brand is null and card_last4 is null
    and recorded_by = (select auth.uid()));
