/**
 * "Email your web person" (the owner, 2026-11-12): what a business's website needs before the carriers approve its
 * texting, each fix in its own text file (core's website-fixes.ts), emailed to whoever looks after the site.
 *
 * It goes from HandsFreeOS's support desk as a ticket (the owner, 2026-11-16: "it should be sending from handsfreeos
 * like a support ticket and if they respond it should go there as well"). The ticket is on Admin → Support desk with
 * the web person as who it's with, the email is its first message, and its own Reply-To brings their answer back to
 * it, the way any ticket's mail does (support/inbound.ts). Whoever pressed Send is copied in and in the Reply-To too,
 * so their answer reaches them as well. It's named for the business ("Shop Your Solar via HandsFreeOS"), because the
 * web person doesn't know us.
 *
 * The files are written now, from the business as it is when it goes: `registration.email_web_person` already
 * refused what couldn't be written, so a refusal here means something changed in between, and the email isn't sent
 * half right. Nothing is skipped quietly: an email that can't go leaves its ticket in the queue saying why.
 */
import { randomUUID } from 'node:crypto';
import {
  HfosError,
  refuseUnwritable,
  WEBSITE_FIX_IDS,
  webPersonEmail,
  websiteFixFactsFrom,
  websiteFixFiles,
  websiteFixSourcesOf,
  type WebsiteFixFile,
  type WebsiteFixId,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { ticketEvents, ticketMessages, tickets } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import { renderEmailHtml } from '../email/render';
import { isPermanentEmailError } from '../email/transport';
import { publicOrigin } from '../hosting/origin';
import { practiceNow } from '../practice/scope';
import { tenantOf } from '../services';
import { isOurSupportAddress, supportAddresses } from '../support/mail';
import type { EventHandler, HandlerContext } from './types';

interface Payload {
  readonly to?: string;
  readonly name?: string | null;
  readonly fixes?: readonly string[];
  readonly formId?: string | null;
  readonly note?: string | null;
}

interface Sender {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** HandsFreeOS support: the ticket is theirs, and its first message is in their name. */
  readonly staff: boolean;
}

/** Whoever pressed Send. The founder working in the business is readable too (20261027028000). */
async function senderOf(ctx: HandlerContext): Promise<Sender | null> {
  if (!ctx.event.actorId) return null;
  const [row] = await rows<{ email: string; full_name: string | null; staff: boolean }>(
    ctx.tx,
    sql`select u.email::text as email, u.full_name,
               exists (select 1 from platform.staff s where s.user_id = u.id and s.status = 'active') as staff
        from app.users u where u.id = ${ctx.event.actorId}`,
  );
  return row
    ? { id: ctx.event.actorId, email: row.email, name: row.full_name ?? '', staff: row.staff }
    : null;
}

/** What the files said, kept on the ticket for whoever answers the web person's questions. */
function sentNote(sender: Sender | null, business: string, files: readonly WebsiteFixFile[]) {
  const who = sender ? `${sender.name.trim() || sender.email} (${sender.email})` : 'someone';
  return [
    `Sent for ${business} by ${who}, from Email your web person. Their reply comes back to this ticket${sender ? ', and to them' : ''}.`,
    '',
    'What the files said:',
    ...files.flatMap((f) => ['', `--- ${f.filename} ---`, f.text.trim()]),
  ].join('\n');
}

export const onWebPersonEmailed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.event.payload as Payload;
  const to = p.to?.trim().toLowerCase();
  const fixes = WEBSITE_FIX_IDS.filter((id): id is WebsiteFixId => !!p.fixes?.includes(id));
  if (!to || fixes.length === 0) return;

  const sender = await senderOf(ctx);
  if (!sender)
    ctx.log.warn(
      { eventId: ctx.event.id },
      'web person email: who sent it isn’t readable, so it goes unsigned',
    );
  const [ws] = await rows<{ name: string }>(
    ctx.tx,
    sql`select name from app.workspaces where id = ${scope.workspaceId}`,
  );

  // Why it can't go, when it can't: changed since it was asked for (the form unpublished, say), where trying again
  // won't help and half right is worse, or an address that would write to the support desk itself.
  let notSent: string | null = isOurSupportAddress(ctx, to)
    ? `${to} is HandsFreeOS’s own support address, so it wasn’t sent there.`
    : null;
  let business = ws?.name ?? 'The business';
  let files: WebsiteFixFile[] = [];
  if (!notSent)
    try {
      const sources = await websiteFixSourcesOf(ctx.tx, scope.workspaceId, fixes, p.formId ?? null);
      const facts = websiteFixFactsFrom(sources, {
        app: ctx.webUrl,
        pages: await publicOrigin(ctx.tx, scope.workspaceId, ctx.webUrl),
      });
      refuseUnwritable(facts, fixes);
      business = facts.business;
      files = websiteFixFiles(facts, fixes);
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      notSent = e.message;
    }

  const mail = webPersonEmail({
    business,
    recipientName: p.name ?? null,
    sender: sender && { name: sender.name, email: sender.email },
    files,
    note: p.note ?? null,
  });
  const now = new Date();
  // In this transaction, so a send that fails and is tried again doesn't leave a ticket behind each time.
  const [ticket] = await ctx.tx
    .insert(tickets)
    .values({
      subject: mail.subject,
      channel: 'email',
      status: notSent ? 'open' : 'waiting_on_customer',
      requesterEmail: to,
      requesterName: p.name?.trim() ?? '',
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
      assigneeUserId: sender?.staff ? sender.id : null,
      // A practice business's (Admin → Try onboarding) is marked, so nobody on the desk mistakes it for a real one.
      tags: practiceNow() ? ['web_person', 'practice'] : ['web_person'],
      ...(notSent ? {} : { firstResponseAt: now, lastStaffAt: now }),
    })
    .returning({ id: tickets.id, number: tickets.number, replyToken: tickets.replyToken });
  const number = Number(ticket!.number);
  // The email itself, as the ticket's first message, when there's one to send.
  const [first] = notSent
    ? []
    : await ctx.tx
        .insert(ticketMessages)
        .values({
          ticketId: ticket!.id,
          author: sender?.staff ? 'staff' : 'system',
          authorUserId: sender?.staff ? sender.id : null,
          bodyText: mail.text,
          createdAt: now,
        })
        .returning({ id: ticketMessages.id });
  await ctx.tx.insert(ticketMessages).values({
    ticketId: ticket!.id,
    author: 'staff',
    internal: true,
    authorUserId: sender?.staff ? sender.id : null,
    bodyText: notSent
      ? `Not sent: ${notSent}`
      : sentNote(sender, business, files).slice(0, 100_000),
    // Just after the email, so the desk lists them in that order: one transaction gives both the same now().
    createdAt: new Date(now.getTime() + 1),
  });
  await ctx.tx.insert(ticketEvents).values({
    ticketId: ticket!.id,
    kind: 'web_person_emailed',
    actorUserId: sender?.id ?? null,
    data: { to, files: files.map((f) => f.filename), sent: !notSent },
  });
  // The business's texting check, when one is waiting on the desk: it says where the email went.
  const [review] = await rows<{ ticket_id: string }>(
    ctx.tx,
    sql`select ticket_id from app.registration_reviews
        where workspace_id = ${scope.workspaceId} and status = 'waiting' and ticket_id is not null
        limit 1`,
  );
  if (review)
    await ctx.tx.insert(ticketMessages).values({
      ticketId: review.ticket_id,
      author: 'staff',
      internal: true,
      bodyText: notSent
        ? `Emailing their web person (${to}) didn’t go: ${notSent} See ticket #${number}.`
        : `Emailed their web person, ${to}: ticket #${number}. Their reply lands there.`,
    });

  if (notSent || !first) {
    ctx.log.warn(
      { eventId: ctx.event.id, ticket: number, why: notSent },
      'web person email not sent',
    );
    return;
  }

  const { from, replyTo } = supportAddresses(ctx, ticket!.replyToken);
  const copy = sender && sender.email.toLowerCase() !== to ? sender.email : null;
  try {
    const sent = await ctx.email.transport.send({
      from: { address: from.address, name: `${business} via HandsFreeOS` },
      to: [to],
      cc: copy ? [copy] : [],
      // The ticket first, so their answer lands on it; whoever sent it as well, so it reaches them too.
      replyTo: copy ? `${replyTo}, ${copy}` : replyTo,
      subject: `${mail.subject} [#${number}]`,
      text: mail.text,
      html: renderEmailHtml(`${mail.text}\n\nSent for ${business} through HandsFreeOS.`),
      messageIdHeader: `<${randomUUID()}@${ctx.support.mailDomain}>`,
      inReplyTo: null,
      references: [],
      attachments: files.map((f) => ({
        name: f.filename,
        contentType: 'text/plain; charset=utf-8',
        content: Buffer.from(f.text, 'utf8'),
      })),
      metadata: { support: 'web_person', ticket: String(number) },
    });
    await ctx.tx
      .update(ticketMessages)
      .set({ emailMessageId: sent.messageIdHeader })
      .where(eq(ticketMessages.id, first.id));
  } catch (e) {
    // A refusal for good (an address that bounces, say): kept on the ticket rather than tried again.
    if (!isPermanentEmailError(e)) throw e;
    await ctx.tx
      .update(tickets)
      .set({ status: 'open', firstResponseAt: null, lastStaffAt: null })
      .where(eq(tickets.id, ticket!.id));
    await ctx.tx.insert(ticketMessages).values({
      ticketId: ticket!.id,
      author: 'staff',
      internal: true,
      bodyText: `Not sent: the email service refused it (${e.message}).`,
      createdAt: new Date(now.getTime() + 2),
    });
    ctx.log.warn(
      { eventId: ctx.event.id, ticket: number, err: e.message },
      'web person email refused',
    );
  }
};
