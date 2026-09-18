/**
 * Support mail going out (M13): the acknowledgement, a person's reply, and the invitation that makes
 * somebody staff.
 *
 * It goes through the same transport a business's own mail does, so it is Postmark in production and Mailpit
 * locally, and it carries the threading headers that keep a conversation together: our Message-ID on the way
 * out, the customer's on the way back, and a Reply-To holding the ticket's own token.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { ticketEvents, ticketMessages, tickets } from '@hfos/db/schema';
import type { WorkerServices } from '../services';
import { renderEmailHtml } from '../email/render';
import { escapeHtml } from '../emails/templates';

export type SupportMailContext = Pick<
  WorkerServices,
  'db' | 'log' | 'email' | 'webUrl' | 'support'
>;

/** support@handsfreeos.com, and the address a reply to this ticket comes back to. */
function addresses(ctx: SupportMailContext, replyToken: string | null) {
  const local = ctx.support.addresses[0] ?? 'support';
  const domain = ctx.support.mailDomain;
  return {
    from: { address: `${local}@${domain}`, name: ctx.support.fromName },
    replyTo: replyToken ? `${local}+${replyToken}@${domain}` : `${local}@${domain}`,
  };
}

/** "Re: their subject", without stacking up Re: Re: Re:. */
const reSubject = (subject: string) =>
  /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim() || '(no subject)'}`;

interface TicketMail {
  id: string;
  number: number;
  subject: string;
  replyToken: string | null;
  requesterEmail: string;
  requesterName: string;
  status: string;
}

/** As the database hands it back: bigint arrives as a string. */
interface TicketMailRow extends Record<string, unknown> {
  id: string;
  number: string;
  subject: string;
  replyToken: string | null;
  requesterEmail: string;
  requesterName: string;
  status: string;
}

async function ticketFor(ctx: SupportMailContext, ticketId: string): Promise<TicketMail | null> {
  const [row] = await asWorker(ctx.db, {}, (tx) =>
    rows<TicketMailRow>(
      tx,
      sql`select id, number, subject, reply_token as "replyToken", requester_email::text as "requesterEmail",
                 requester_name as "requesterName", status
          from platform.tickets where id = ${ticketId}`,
    ),
  );
  return row ? { ...row, number: Number(row.number) } : null;
}

/** The last thing they sent us, so our next message answers it in their mail program. */
async function lastFromCustomer(ctx: SupportMailContext, ticketId: string): Promise<string | null> {
  const [row] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ email_message_id: string | null }>(
      tx,
      sql`select email_message_id from platform.ticket_messages
          where ticket_id = ${ticketId} and author = 'customer' and email_message_id is not null
          order by created_at desc limit 1`,
    ),
  );
  return row?.email_message_id ?? null;
}

const signOff = (staffName: string, signature: string) =>
  signature.trim() || `— ${staffName || 'HandsFreeOS Support'}`;

/**
 * A person's answer, on its way to the customer. The ticket number is in the subject so their mail program
 * groups the thread even if every header is stripped on the way.
 */
export async function sendTicketReply(
  ctx: SupportMailContext,
  input: { ticketId: string; messageId: string },
): Promise<void> {
  const ticket = await ticketFor(ctx, input.ticketId);
  if (!ticket) return;
  const [message] = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      body_text: string;
      internal: boolean;
      email_message_id: string | null;
      staff_name: string | null;
      signature: string | null;
      full_name: string | null;
    }>(
      tx,
      sql`select m.body_text, m.internal, m.email_message_id, s.display_name as staff_name,
                 s.signature, u.full_name
          from platform.ticket_messages m
          left join platform.staff s on s.user_id = m.author_user_id
          left join app.users u on u.id = m.author_user_id
          where m.id = ${input.messageId}`,
    ),
  );
  // A note never leaves the building, and a message already sent is never sent twice.
  if (!message || message.internal || message.email_message_id) return;

  const { from, replyTo } = addresses(ctx, ticket.replyToken);
  const staffName = message.staff_name || message.full_name || 'HandsFreeOS Support';
  const inReplyTo = await lastFromCustomer(ctx, ticket.id);
  const body = `${message.body_text}\n\n${signOff(staffName, message.signature ?? '')}`;
  const sent = await ctx.email.transport.send({
    from: { address: from.address, name: `${staffName} · ${ctx.support.fromName}` },
    to: [ticket.requesterEmail],
    cc: [],
    replyTo,
    subject: `${reSubject(ticket.subject)} [#${ticket.number}]`,
    text: body,
    html: renderEmailHtml(body),
    messageIdHeader: `<${randomUUID()}@${ctx.support.mailDomain}>`,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : [],
    attachments: [],
    metadata: { support: 'reply', ticket: String(ticket.number) },
  });
  await asWorker(ctx.db, {}, (tx) =>
    tx
      .update(ticketMessages)
      .set({ emailMessageId: sent.messageIdHeader, emailInReplyTo: inReplyTo })
      .where(eq(ticketMessages.id, input.messageId)),
  );
}

/**
 * "We have it, it's #1042." Sent once per ticket, and only for a ticket that came in by email — someone who
 * asked from inside the app already saw it land on their screen.
 */
export async function acknowledgeTicket(ctx: SupportMailContext, ticketId: string): Promise<void> {
  const ticket = await ticketFor(ctx, ticketId);
  if (!ticket) return;
  const already = await asWorker(ctx.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select id from platform.ticket_events
          where ticket_id = ${ticketId} and kind = 'acknowledged' limit 1`,
    ),
  );
  if (already.length > 0) return;
  const { from, replyTo } = addresses(ctx, ticket.replyToken);
  const first = (ticket.requesterName || '').split(' ')[0] ?? '';
  const text = [
    `${first ? `${first}, thanks` : 'Thanks'} for writing in. We have your message and it is ticket #${ticket.number}.`,
    '',
    'A person reads every one of these, Monday to Friday, and we aim to come back to you the same working day. Anything where your customers cannot be reached — texts not sending, calls not ringing through — jumps the queue.',
    '',
    'You can reply to this email and it lands on the same ticket.',
    '',
    '— HandsFreeOS Support',
  ].join('\n');
  await ctx.email.transport.send({
    from,
    to: [ticket.requesterEmail],
    cc: [],
    replyTo,
    subject: `We have your message [#${ticket.number}]`,
    text,
    html: renderEmailHtml(text),
    messageIdHeader: `<${randomUUID()}@${ctx.support.mailDomain}>`,
    inReplyTo: await lastFromCustomer(ctx, ticket.id),
    references: [],
    attachments: [],
    metadata: { support: 'acknowledgement', ticket: String(ticket.number) },
  });
  await asWorker(ctx.db, {}, (tx) =>
    tx.insert(ticketEvents).values({ ticketId, kind: 'acknowledged', data: {} }),
  );
}

/** The invitation that makes someone staff. Plain, and it says who asked. */
export function staffInvitationEmail(input: {
  inviterName: string;
  role: string;
  link: string;
  expiresAt: Date;
}): { subject: string; text: string; html: string } {
  const role =
    input.role === 'admin'
      ? 'a support admin'
      : input.role === 'lead'
        ? 'a support lead'
        : 'a support agent';
  const expires = input.expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const subject = `${input.inviterName} asked you to help run HandsFreeOS support`;
  const text = `${input.inviterName} invited you to answer HandsFreeOS support as ${role}.

Accept the invitation: ${input.link}

This link works once, only for this email address, and expires on ${expires}. If you were not expecting it, you can ignore this email.`;
  const html = `<div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; max-width: 520px;">
  <p style="font-size: 15px; line-height: 1.5;"><strong>${escapeHtml(input.inviterName)}</strong> invited you to answer HandsFreeOS support as ${escapeHtml(role)}.</p>
  <p style="margin: 24px 0;"><a href="${input.link}" style="display: inline-block; background: #2d69d8; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">Accept invitation</a></p>
  <p style="font-size: 13px; color: #5b616a; line-height: 1.5;">This link works once, only for this email address, and expires on ${escapeHtml(expires)}. If you were not expecting it, you can ignore this email.</p>
</div>`;
  return { subject, text, html };
}

/** Where a ticket lives, for links in staff-facing mail. */
export const ticketUrl = (webUrl: string, ticketId: string) =>
  `${webUrl}/admin/tickets/${ticketId}`;

/** Kept next to the rest of the mail so the one place that knows the shape of a ticket is here. */
export async function ticketNumberOf(
  ctx: SupportMailContext,
  ticketId: string,
): Promise<number | null> {
  const [row] = await asWorker(ctx.db, {}, (tx) =>
    tx.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId)),
  );
  return row ? Number(row.number) : null;
}
