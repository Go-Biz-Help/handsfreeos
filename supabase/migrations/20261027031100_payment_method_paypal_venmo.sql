-- =============================================================================
-- 20261027031100 · PayPal and Venmo as ways a payment was made (PayPal plan,
-- part 4). PayPal's buttons on the customer's pages take money through the
-- business's PayPal account: from the customer's PayPal balance or bank, from
-- Venmo, or from a card through PayPal's own card button. The card case stays
-- `card`; the other two are new.
--
-- Alone in its file: Postgres can't use a new enum value in the transaction
-- that adds it, and 20261027031200_payment_method_paypal_settles.sql uses them.
-- =============================================================================

alter type app.payment_method add value if not exists 'paypal';
alter type app.payment_method add value if not exists 'venmo';
