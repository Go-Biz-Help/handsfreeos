-- =============================================================================
-- 0102 · RCS, part 1: enum values and types. A business with an RCS sender
--        texts its customers as itself — its name, its logo, a tick that says
--        it is verified — with pictures, buttons and cards, and the phones that
--        can't show RCS get the same message as an ordinary text. It all stays
--        one thread: RCS is how a text travels, never a channel of its own, so
--        `app.channel` is untouched and a customer's texts and RCS messages
--        live in the same conversation.
--
--        Three things are new. A text can be **read** (RCS says when the
--        customer opened it), so `app.message_status` gains `read`, after
--        `delivered` because it only ever follows it. A text now has a
--        **transport** — the way it actually went: SMS, MMS or RCS — which is
--        what the thread shows under each message. And a business's **RCS
--        sender** is connected, reviewed and watched, which needs a status of
--        its own.
--
--        They are added in a migration of their own because Postgres can't use
--        a new enum value in the transaction that adds it; the table, columns
--        and functions that use them follow in 0103 (20261005000400).
-- =============================================================================

alter type app.message_status add value if not exists 'read' after 'delivered';

-- How a text went (or came in): as an SMS, as a picture message, or over RCS. Null until the carrier says,
-- because a text sent RCS-first only learns which way it went from its first status callback.
create type app.text_transport as enum ('sms', 'mms', 'rcs');

-- A business's RCS sender, as HandsFreeOS sees it:
--   connecting     a person asked to connect it; the worker is checking it with Twilio
--   in_review      Twilio has it, but the carriers have not approved it yet: texts still go as SMS
--   active         approved and on the business's messaging service: texts go RCS first
--   offline        Twilio says it stopped (the carriers took it down): texts go as SMS until it is back
--   failed         it could not be connected (not found in this business's Twilio account, most often)
--   disconnecting  a person let it go; the worker is taking it off the messaging service
--   disconnected   gone, kept for history
create type app.rcs_sender_status as enum (
  'connecting', 'in_review', 'active', 'offline', 'failed', 'disconnecting', 'disconnected'
);
