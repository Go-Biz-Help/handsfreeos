-- =============================================================================
-- A business the agency pays for: a wallet stage of its own.
--
--        `agency`: its usage is recorded at cost and price like any other,
--        and nobody bills it. The business never hears of a balance, is never
--        warned or stopped, and is never asked for a card or topped up: its
--        agency, the organization it belongs to, absorbs what it uses. For
--        the operator's own workspaces. Only staff set it, the same way as
--        the other stages (`private.set_wallet_stage`).
--
--        The value is added on its own: Postgres won't use a new enum value
--        in the transaction that added it, and the next migration does.
-- =============================================================================

alter type app.wallet_stage add value if not exists 'agency';
