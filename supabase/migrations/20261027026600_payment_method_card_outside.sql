-- =============================================================================
-- Invoices paid outside Stripe or Square, a: "Card (other machine)", a card a
-- business takes on its own terminal (Chase QuickAccept, a Clover, a bank's
-- reader) and writes down here by hand. Alone in its file: Postgres can't use
-- a new enum value in the transaction that adds it, and
-- 20261027026700_paid_outside.sql uses it.
-- =============================================================================

alter type app.payment_method add value if not exists 'card_outside';
