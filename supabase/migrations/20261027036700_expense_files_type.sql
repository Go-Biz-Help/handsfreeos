-- =============================================================================
-- Receipts and expenses, a: a record type for a receipt (the owner, 25 Nov
-- 2026: "Receipts and expenses: I snap a receipt, it gets filed, and each month
-- I see money in and money out"). A receipt belongs to the business's expense,
-- not to a customer, so its file's record is the expense. Alone in its file:
-- Postgres can't use a new enum value in the transaction that adds it, and
-- 20261027036800_expenses.sql uses it.
-- =============================================================================

alter type app.record_type add value if not exists 'expense';
