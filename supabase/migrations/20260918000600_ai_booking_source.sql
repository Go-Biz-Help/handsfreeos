-- =============================================================================
-- 0035 · The AI teammate's bookings, part 1: their own appointment source.
--        Until now the teammate's bookings were filed as 'booking_page'. A new
--        enum value can't be used in the transaction that adds it, so the
--        policies that keep people from writing it follow in 0036
--        (20260918000700).
-- =============================================================================

alter type app.appointment_source add value if not exists 'ai_teammate';
