-- =============================================================================
-- 0089 · A thread belongs to the line it came in on (M18).
--
--        Since 0011 a conversation has been unique on
--        `(workspace_id, channel, counterpart)`: one customer, one channel, one
--        thread, whichever of the business's numbers or addresses they actually
--        wrote to. That was right while a business had one number. 0077 gave it
--        several, and this is the half of that change that never landed — the
--        thread stayed keyed on the customer alone, so a customer who texted the
--        dispatch line after texting the front desk had their message filed under
--        the front desk, and `conversationNumber()` answered them from a line
--        they had not written to. The number was right in the schema and wrong on
--        the customer's phone.
--
--        So the key gains the line: the channel says which column holds it, and
--        the nil uuid stands in when neither does. A text lane is one of the
--        business's numbers, a mail lane one of its addresses, and a chat has
--        neither, so the nil uuid keeps every chat with one visitor on one thread
--        exactly as before. The channel is asked rather than the two columns
--        coalesced, so a stray `email_address_id` on a text thread can never
--        quietly become that thread's identity. Written inline rather than as a
--        stored column because
--        `phone_number_id` and `email_address_id` already ride the sync stream —
--        a third column would make every phone copy every thread again
--        (apps/sync/sync-config.yaml says why that is expensive) to carry a value
--        it can already work out.
--
--        **Nothing splits on its own.** The index is the only thing that would
--        let a second lane exist, and a second lane is created only when a
--        customer writes to a line they have not used before. Everything already
--        here keeps one thread, because the backfill below gives every thread a
--        line first: an `sms` thread with no number takes the business's default
--        number, a mail thread with no address its default address. That is not a
--        guess — `conversationNumber()` and `pickFromAddress()` have both fallen
--        back to exactly that row since 0077, so the backfill writes down the
--        line these threads were already being answered from.
--
--        **The backfill cannot collide**, which is the property to defend in
--        review: the constraint being dropped allowed at most one row per
--        `(workspace_id, channel, counterpart)`, so at most one row per group can
--        be rewritten, and one row cannot conflict with itself. It runs between
--        the drop and the new index for that reason.
--
--        **A thread with no line stays legal.** A business that has never bought
--        a number, or one whose only number was released, has threads the
--        backfill cannot fill. They land in the nil lane together, which is one
--        lane, which is what they already were.
-- =============================================================================

alter table app.conversations
  drop constraint conversations_workspace_id_channel_counterpart_key;

-- ---------- every thread already here gets the line it was being answered from ----------
-- Texts: the business's default live number, which is the row `defaultNumber()` hands back.
update app.conversations c
   set phone_number_id = n.id
  from app.phone_numbers n
 where c.channel = 'sms'
   and c.phone_number_id is null
   and n.workspace_id = c.workspace_id
   and n.status in ('provisioning', 'active', 'releasing')
   and n.is_default;

-- Mail: the business's default address, which is the row `pickFromAddress()` falls back to.
update app.conversations c
   set email_address_id = a.id
  from app.email_addresses a
 where c.channel = 'email'
   and c.email_address_id is null
   and a.workspace_id = c.workspace_id
   and a.is_default;

-- ---------- the new key ----------
-- One thread per customer per line. The nil uuid is "no line": chats, and threads belonging to a business
-- with nothing to send from. They share one lane rather than each becoming their own.
create unique index conversations_one_per_line on app.conversations (
  workspace_id,
  channel,
  counterpart,
  coalesce(
    case when channel = 'email' then email_address_id else phone_number_id end,
    '00000000-0000-0000-0000-000000000000'::uuid)
);

comment on index app.conversations_one_per_line is
  'One thread per customer per line of the business (0089). Replaces the one-thread-per-customer key from '
  '0011. The expression is the lane: a number for a text, an address for mail, and the nil uuid for a chat or '
  'for a business with no line to send from.';
