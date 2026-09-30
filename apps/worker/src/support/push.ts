/**
 * A new support ticket, on the support people's phones (apps/worker/src/push/README.md, `support_ticket`).
 *
 * Both ways a ticket starts queue it: asking from inside the app (`support_ticket.opened`, handlers/support.ts) and
 * mail to support@ that starts something new (inbound.ts). A customer's answer on a ticket that is already there
 * pushes nobody: the queue shows it, and support people would otherwise hear about every reply.
 *
 * It goes to every active support person with the switch on, except whoever wrote in (a support person trying the
 * form). It is queued in the transaction that files the ticket, in a savepoint of its own: a push that can't be
 * queued never costs the ticket, the acknowledgement or the draft.
 */
import { supportTicketPushWords } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { errorMessage } from '../outbox';
import { queueStaffPush } from '../push/queue';

/**
 * Queues the push for a ticket that just started; answers how many people it is for. `business` names the business
 * it is about when the caller knows it and `tx` can't read it (support mail is filed holding no business); without
 * it, the name is read in `tx`'s own scope.
 */
export async function queueNewTicketPush(
  tx: Tx,
  log: Pick<Logger, 'warn'>,
  ticketId: string,
  opts: { readonly business?: string | null } = {},
): Promise<number> {
  try {
    return await tx.transaction(async (sp) => {
      const [t] = await rows<{
        number: string | number;
        subject: string;
        requester_name: string;
        requester_email: string;
        requester_user_id: string | null;
        business: string | null;
        preview: string | null;
      }>(
        sp,
        sql`select t.number, t.subject, t.requester_name, t.requester_email::text as requester_email,
                   t.requester_user_id,
                   (select w.name from app.workspaces w where w.id = t.workspace_id) as business,
                   (select m.body_text from platform.ticket_messages m
                    where m.ticket_id = t.id and m.author = 'customer' and not m.internal
                    order by m.created_at, m.id limit 1) as preview
            from platform.tickets t where t.id = ${ticketId}`,
      );
      if (!t) return 0;
      const words = supportTicketPushWords({
        number: Number(t.number),
        subject: t.subject,
        preview: t.preview,
        requester: t.requester_name.trim() || t.requester_email,
        business: opts.business ?? t.business,
      });
      return queueStaffPush(sp, {
        key: `support_ticket:${ticketId}`,
        category: 'support_ticket',
        exceptUserId: t.requester_user_id,
        title: words.title,
        about: words.about,
        body: words.body,
        path: `/admin/tickets/${ticketId}`,
        refs: { ticketId },
        collapseId: `ticket-${ticketId}`,
      });
    });
  } catch (e) {
    log.warn({ err: errorMessage(e), ticketId }, 'could not queue the new ticket’s push');
    return 0;
  }
}
