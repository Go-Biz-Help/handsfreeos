import { and, eq } from 'drizzle-orm';
import { conversations } from '@hfos/db/schema';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  activeSuppression,
  pickFromAddress,
  replySubject,
  sendableMailboxes,
  threadHeaders,
  workspaceAddresses,
} from '../messaging/email';
import { latestConversation } from '../messaging/store';
import { EmailComposeOptionsInput, EmailComposeOptionsOutput } from '../schemas/message';

export const emailComposeOptions = defineQuery({
  name: 'email.compose_options',
  description:
    'What the composer needs to email a customer: their address, whether email to them is stopped, the addresses and mailboxes to send from, and the reply subject.',
  input: EmailComposeOptionsInput,
  output: EmailComposeOptionsOutput,
  permission: 'inbox.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const workspaceId = input.workspaceId;
    let to: string | null = null;
    let conversationId: string | null = null;
    let usedAddressId: string | null = null;
    if (input.conversationId) {
      const [c] = await ctx.tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.workspaceId, workspaceId),
          ),
        );
      if (!c) throw HfosError.notFound('Conversation not found.');
      if (c.channel === 'email') {
        to = c.counterpart;
        conversationId = c.id;
        usedAddressId = c.emailAddressId;
      } else if (c.personId) {
        to = (await requirePerson(ctx.tx, workspaceId, c.personId)).email?.toLowerCase() ?? null;
      }
    } else {
      to = (await requirePerson(ctx.tx, workspaceId, input.personId!)).email?.toLowerCase() ?? null;
    }
    // A customer's text thread (or page) finds their email thread by address.
    if (to && !conversationId) {
      // The one they last wrote to, since a customer can have a mail thread on more than one of the
      // business's addresses (0089). Composing into the older of the two would answer them on an address
      // they have moved off.
      const c = await latestConversation(ctx.tx, workspaceId, 'email', to);
      if (c) {
        conversationId = c.id;
        usedAddressId = c.emailAddressId;
      }
    }
    const stopped = to ? await activeSuppression(ctx.tx, workspaceId, to) : null;
    const addresses = await workspaceAddresses(ctx.tx, workspaceId);
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const mailboxes = await sendableMailboxes(ctx.tx, workspaceId, me);
    const thread = conversationId ? await threadHeaders(ctx.tx, conversationId) : null;
    return {
      to,
      conversationId,
      canEmail: {
        ok: !!to && !stopped,
        reason: !to ? ('no_email' as const) : stopped ? ('suppressed' as const) : null,
      },
      suppressed: stopped
        ? { reason: stopped.reason, since: stopped.createdAt.toISOString() }
        : null,
      addresses: addresses.map(({ id, address, displayName, isDefault, usable }) => ({
        id,
        address,
        displayName,
        isDefault,
        usable,
      })),
      fromAddressId: pickFromAddress(addresses, [usedAddressId])?.id ?? null,
      mailboxes: mailboxes.map(({ id, provider, accountEmail, displayName }) => ({
        id,
        provider,
        accountEmail,
        displayName,
      })),
      replySubject: replySubject(thread?.subject),
    };
  },
});
