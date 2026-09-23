-- =============================================================================
-- 0092 · Money the AI teammate asked for (M18). With an owner's or admin's OK,
--        the teammate can send a customer a bill it put together from the price
--        list. It is an ordinary invoice — same page to pay on, same numbering —
--        and `origin` keeps where it came from, the way it does for a form or the
--        Assistant, so "what did the teammate bring in last month?" has an
--        answer.
--
--        IF NOT EXISTS keeps a re-run harmless, as 0078 does.
-- =============================================================================

alter type app.money_origin add value if not exists 'ai_teammate';
