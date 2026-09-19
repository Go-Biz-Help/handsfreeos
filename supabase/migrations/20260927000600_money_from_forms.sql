-- =============================================================================
-- 0078 · Money that came from a form (M15). A form can ask for a deposit, and
--        what it asks for becomes an invoice like every other one the business
--        raises — same document, same page to pay on, same receipt. But where a
--        document came from is worth keeping: "how much did the booking form
--        take last month?" is a question a business asks, and `origin` is where
--        that is answered.
--
--        Postgres adds an enum value outside a transaction in older versions;
--        since 12 it can be done inside one, which is what the migration runner
--        uses. IF NOT EXISTS keeps a re-run harmless.
-- =============================================================================

alter type app.money_origin add value if not exists 'form';
