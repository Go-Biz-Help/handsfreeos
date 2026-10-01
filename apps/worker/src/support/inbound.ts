/**
 * Mail to support@handsfreeos.com, filed as a ticket (M13).
 *
 * The rules are the ones a person would use. A reply token in the address names its ticket outright. Failing
 * that, the headers say what the message answers, and that names it. Failing that it is something new. A
 * customer answering a ticket we had marked solved reopens it rather than starting again — people do not
 * think in tickets, they think in conversations.
 *
 * Automatic mail (out-of-office, mailer daemons) is dropped, exactly as it is for a business's own inbox:
 * nothing here ever writes back to something that writes back.
 *
 * Something new also goes to the support people's phones (push.ts); an answer on a ticket already there doesn't.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { tickets, ticketEvents, ticketMessages } from '@hfos/db/schema';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import { errorMessage } from '../outbox';
import { acknowledgeTicket, isOurSupportAddress } from './mail';
import { queueNewTicketPush } from './push';
import {
  headerOf,
  htmlToText,
  isAutomatic,
  messageIds,
  sanitizeInboundHtml,
  type MailHeader,
} from '../email/render';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

interface StoredParty {
  Email?: string;
  Name?: string;
}
interface StoredMedia {
  bucket: string;
  objectPath: string;
  contentType: string;
  sizeBytes: number;
  name: string;
  contentId: string | null;
}
interface StoredSupportInbound {
  MessageID: string;
  From?: string;
  FromName?: string;
  FromFull?: StoredParty;
  ToFull?: StoredParty[];
  Subject?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Headers?: MailHeader[];
  Attachments?: StoredMedia[];
  support?: { replyToken: string | null };
}

interface Found {
  ticketId: string;
  status: string;
}

/**
 * The business this address works in, when there is exactly one — otherwise the ticket waits to be linked
 * by hand. The worker holds no tenant scope here (support mail belongs to nobody), so the answer comes from
 * a function that is allowed to look rather than from a query that would see nothing.
 */
async function whoWroteIn(
  ctx: DeliveryContext,
  address: string,
): Promise<{
  userId: string;
  fullName: string;
  workspaceId: string | null;
  organizationId: string | null;
} | null> {
  const found = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      user_id: string;
      full_name: string;
      workspace_id: string | null;
      organization_id: string | null;
    }>(tx, sql`select * from private.support_requester(${address})`),
  );
  const first = found[0];
  if (!first) return null;
  // In more than one business, we cannot know which they mean, so nobody guesses.
  const single = found.length === 1 ? first : null;
  return {
    userId: first.user_id,
    fullName: first.full_name ?? '',
    workspaceId: single?.workspace_id ?? null,
    organizationId: single?.organization_id ?? null,
  };
}

/**
 * The name of the one business the writer works in, for the new ticket's push. Read holding that business's scope:
 * the mail is filed holding none, and from there no business is readable. It only words a notification, so a read
 * that fails leaves the name out rather than holding up the mail.
 */
async function businessName(
  ctx: DeliveryContext,
  writer: { workspaceId: string | null; organizationId: string | null } | null,
): Promise<string | null> {
  if (!writer?.workspaceId || !writer.organizationId) return null;
  const scope = { workspaceId: writer.workspaceId, organizationId: writer.organizationId };
  try {
    const [ws] = await asWorker(ctx.db, scope, (tx) =>
      rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${scope.workspaceId}`,
      ),
    );
    return ws?.name ?? null;
  } catch (e) {
    ctx.log.warn(
      { err: errorMessage(e) },
      'could not read the business’s name for the new ticket’s push',
    );
    return null;
  }
}

/** The ticket this message belongs to: its reply token, then what it answers, then nothing. */
async function findTicket(
  ctx: DeliveryContext,
  replyToken: string | null,
  answers: readonly string[],
): Promise<Found | null> {
  return asWorker(ctx.db, {}, async (tx) => {
    if (replyToken) {
      const [byToken] = await tx
        .select({ id: tickets.id, status: tickets.status })
        .from(tickets)
        .where(eq(tickets.replyToken, replyToken));
      if (byToken) return { ticketId: byToken.id, status: byToken.status };
    }
    for (const messageId of answers) {
      const [byHeader] = await rows<{ ticket_id: string; status: string }>(
        tx,
        sql`select m.ticket_id, t.status from platform.ticket_messages m
            join platform.tickets t on t.id = m.ticket_id
            where m.email_message_id = ${messageId}
            order by m.created_at desc limit 1`,
      );
      if (byHeader) return { ticketId: byHeader.ticket_id, status: byHeader.status };
    }
    return null;
  });
}

/** A ticket that was merged into another belongs to the other one; follow it to the end. */
async function unmerged(ctx: DeliveryContext, ticketId: string): Promise<string> {
  const [row] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`with recursive chain as (
            select id, merged_into from platform.tickets where id = ${ticketId}
            union all
            select t.id, t.merged_into from platform.tickets t join chain c on t.id = c.merged_into)
          select id from chain where merged_into is null limit 1`,
    ),
  );
  return row?.id ?? ticketId;
}

export const onSupportInboundEmail: DeliveryProcessor = async (ctx) => {
  const p = ctx.delivery.params as unknown as StoredSupportInbound;
  if (!p.MessageID) return 'ignored';
  const headers = p.Headers ?? [];
  if (isAutomatic(headers)) {
    ctx.log.info('an automatic reply to support was not filed');
    return 'ignored';
  }
  const from = (p.FromFull?.Email ?? p.From ?? '').trim().toLowerCase();
  if (!EMAIL.test(from)) return 'ignored';
  // Mail from one of our own support addresses is never filed. Answering it would send to ourselves, and
  // that answer would arrive here again: a loop with real mail on every turn.
  if (isOurSupportAddress(ctx, from)) {
    ctx.log.warn({ from }, 'support mail from our own address was not filed');
    return 'ignored';
  }

  const media = (p.Attachments ?? []).slice(0, 20);
  const cids = new Map<string, number>();
  media.forEach((m, i) => {
    if (m.contentId) cids.set(m.contentId.replace(/^<|>$/g, ''), i);
  });
  const text =
    p.StrippedTextReply?.trim() || p.TextBody?.trim() || (p.HtmlBody ? htmlToText(p.HtmlBody) : '');
  const messageIdHeader = messageIds(headerOf(headers, 'Message-ID'))[0] ?? null;
  const answers = [
    ...messageIds(headerOf(headers, 'In-Reply-To')),
    ...messageIds(headerOf(headers, 'References')),
  ];
  const subject = (p.Subject ?? '').slice(0, 500);
  const fromName = (p.FromFull?.Name ?? p.FromName ?? '').trim().slice(0, 200);

  const found = await findTicket(ctx, p.support?.replyToken ?? null, answers);
  const writer = await whoWroteIn(ctx, from);
  const now = new Date();

  const ticketId = found ? await unmerged(ctx, found.ticketId) : null;
  const business = ticketId ? null : await businessName(ctx, writer);

  let filedAs = ticketId ?? '';
  await asWorker(ctx.db, {}, async (tx) => {
    let id = ticketId;
    let opened = false;
    if (id) {
      // Their answer brings the ticket back to us, whatever we had marked it.
      await tx
        .update(tickets)
        .set({ status: 'open', lastCustomerAt: now, snoozeUntil: null, resolvedAt: null })
        .where(eq(tickets.id, id));
    } else {
      const [created] = await tx
        .insert(tickets)
        .values({
          subject: subject || '(no subject)',
          channel: 'email',
          status: 'new',
          requesterEmail: from,
          requesterName: fromName || (writer?.fullName ?? ''),
          requesterUserId: writer?.userId ?? null,
          workspaceId: writer?.workspaceId ?? null,
          organizationId: writer?.organizationId ?? null,
          lastCustomerAt: now,
        })
        .returning({ id: tickets.id, number: tickets.number });
      id = created!.id;
      opened = true;
    }
    // The unique index on the Message-ID is what stops a webhook delivered twice being filed twice.
    await tx
      .insert(ticketMessages)
      .values({
        ticketId: id,
        author: 'customer',
        authorUserId: writer?.userId ?? null,
        bodyText: text.slice(0, 100_000),
        bodyHtml: p.HtmlBody ? sanitizeInboundHtml(p.HtmlBody, cids).slice(0, 1_000_000) : null,
        emailMessageId: messageIdHeader,
        emailInReplyTo: answers[0] ?? null,
        attachments: media.map(({ name, contentType, sizeBytes, bucket, objectPath }) => ({
          name: name.slice(0, 200),
          contentType,
          sizeBytes,
          bucket,
          objectPath,
        })),
      })
      .onConflictDoNothing();
    await tx.insert(ticketEvents).values({
      ticketId: id,
      kind: opened ? 'opened' : 'customer_replied',
      data: { channel: 'email', from },
    });
    // Queued with the ticket: a ticket that isn't filed pushes nobody.
    if (opened) await queueNewTicketPush(tx, ctx.log, id, { business });
    filedAs = id;
  });

  ctx.log.info({ ticketId: filedAs, from, opened: !ticketId }, 'support mail filed');

  // Both of these are courtesies, and neither is worth re-filing the mail for: the ticket is already
  // written down, and a delivery that retried would only try to write it again.
  try {
    if (!ticketId) await acknowledgeTicket(ctx, filedAs);
    await queueSupportDraft(ctx, filedAs);
  } catch (e) {
    ctx.log.warn(
      { err: e, ticketId: filedAs },
      'the ticket was filed, but the reply to it was not',
    );
  }
  return;
};

/** The AI's draft is written on a job, so slow model calls never hold up the mail. */
export async function queueSupportDraft(
  ctx: Pick<DeliveryContext, 'db'>,
  ticketId: string,
): Promise<void> {
  await asWorker(ctx.db, {}, (tx) =>
    tx.execute(sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload)
      values ('support.draft', ${`support.draft:${ticketId}`}, now(), ${JSON.stringify({ ticketId })}::jsonb)
      on conflict do nothing`),
  );
}
