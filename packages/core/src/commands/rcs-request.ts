/**
 * A business asking HandsFreeOS for an RCS sender, and paying for it (0104).
 *
 * **Why asking, not making.** Twilio makes RCS senders only in its own console, and a business's Twilio account
 * is a subaccount only HandsFreeOS can open. So a business tells us what its sender should show, pays, and a
 * support ticket opens; HandsFreeOS makes the sender at Twilio and connects it (commands/rcs.ts), and the
 * carriers' review runs from there.
 *
 * **Shaped like a founding checkout** (commands/founding.ts): `rcs_request.submit` writes a `pending` request in
 * the person's own name and nothing else; a worker job makes the Stripe page (`record_opened`); Stripe's signed
 * event says the money is in (`record_paid`), which is what opens the ticket. The money is believed only from
 * that event. The yearly renewal is the worker's too (`record_renewal`), charged to the card the first payment
 * kept. `private.guard_rcs_request_update()` keeps everything Stripe said the worker's to write.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  numberImports,
  phoneNumbers,
  rcsRequests,
  telephonyAccounts,
  ticketEvents,
  ticketMessages,
  workspaces,
} from '@hfos/db/schema';
import { formatUtcDate } from '../crm/format';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { CLAIMED_STATUSES, currentRcsSender, liveRcsRequest } from '../messaging/store';
import { money } from '../money/format';
import { RCS_FIRST_YEAR_CENTS, RCS_FIRST_YEAR_LINES, RCS_YEARLY_CENTS } from '../money/rcs-fees';
import {
  RcsBrand,
  RcsRequestRecordClosedInput,
  RcsRequestRecordOpenedInput,
  RcsRequestRecordOutput,
  RcsRequestPayRenewalOutput,
  RcsRequestRecordPaidInput,
  RcsRequestRecordRenewalInput,
  RcsRequestRecordRenewalPageInput,
  RcsRequestRefOutput,
  RcsRequestSubmitInput,
  RcsRequestWorkspaceInput,
} from '../schemas/rcs-request';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type RequestRow = typeof rcsRequests.$inferSelect;

const refOf = (r: Pick<RequestRow, 'id' | 'status' | 'sessionUrl'>) => ({
  rcsRequestId: r.id,
  status: r.status,
  checkoutUrl: r.status === 'open' ? r.sessionUrl : null,
});

/** "Oct 1, 2027": a ticket is read by people in any time zone, and a year away needs its year. */
const longDate = formatUtcDate;

/** A year on from `from`, on the same day of the month (Feb 29 lands on Mar 1). */
export function yearAfter(from: Date): Date {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

const workspaceName = async (tx: Tx, workspaceId: string) =>
  (
    await tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
  )[0]?.name ?? 'this business';

/** What the business asked for, as staff read it on the ticket. */
function brandLines(brand: Record<string, unknown>): string[] {
  const b = RcsBrand.partial().safeParse(brand);
  const v = b.success ? b.data : {};
  return [
    `Name customers see: ${v.displayName ?? '—'}`,
    `Description: ${v.description ?? '—'}`,
    `Brand color: ${v.color ?? '—'}`,
    `Website: ${v.website ?? '—'}`,
    `Privacy policy: ${v.privacyUrl ?? '—'}`,
    `Terms of service: ${v.termsUrl ?? '—'}`,
    `Phone on the profile: ${v.phone ?? '—'}`,
    `Email on the profile: ${v.email ?? '—'}`,
    `Logo: ${v.logoUrl ?? 'not sent yet'}`,
    ...(v.notes ? [`Notes: ${v.notes}`] : []),
  ];
}

/**
 * Opens a ticket for the support desk, as the worker writing for this business: the request's person is the
 * requester (an owner of the business when they have gone), so a reply from support reaches them by email.
 * `customer` is what the business asked, in its own terms; `note` is for staff only. The command that calls
 * this emits `support_ticket.opened`, which is what tells support's phones and asks the AI for a draft.
 */
async function openTicket(
  ctx: CommandContext,
  input: {
    readonly requestedBy: string | null;
    readonly subject: string;
    readonly customer: string;
    readonly note: string;
    readonly context: Record<string, unknown>;
  },
): Promise<{ id: string; number: number }> {
  const workspaceId = ctx.scope.workspaceId!;
  const [who] = await rows<{ id: string; email: string; full_name: string | null }>(
    ctx.tx,
    sql`select id, email, full_name from (
          select u.id, u.email::text as email, u.full_name, 0 as pick from app.users u
          where u.id = ${input.requestedBy}
          union all
          (select u.id, u.email::text, u.full_name, 1 from app.workspace_memberships m
           join app.users u on u.id = m.user_id
           where m.workspace_id = ${workspaceId} and m.role = 'owner'
           order by m.created_at limit 1)) who
        order by pick limit 1`,
  );
  if (!who) throw HfosError.internal();
  const [ws] = await ctx.tx
    .select({ organizationId: workspaces.organizationId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [t] = await rows<{ id: string; number: number | string }>(
    ctx.tx,
    sql`insert into platform.tickets (subject, channel, requester_email, requester_name, requester_user_id,
          workspace_id, organization_id, last_customer_at)
        values (${input.subject.slice(0, 500)}, 'in_app', ${who.email}, ${who.full_name ?? ''}, ${who.id},
          ${workspaceId}, ${ws?.organizationId ?? null}, now())
        returning id, number`,
  );
  if (!t) throw HfosError.internal();
  await ctx.tx.insert(ticketMessages).values([
    { ticketId: t.id, author: 'customer', authorUserId: who.id, bodyText: input.customer },
    // An internal note, which the desk keeps to staff: it shows as from HandsFreeOS, with nobody's name on it.
    { ticketId: t.id, author: 'staff', internal: true, bodyText: input.note },
  ]);
  await ctx.tx.insert(ticketEvents).values({ ticketId: t.id, kind: 'opened', data: input.context });
  return { id: t.id, number: Number(t.number) };
}

export const rcsRequestSubmit = defineCommand({
  name: 'rcs_request.submit',
  description: `Ask HandsFreeOS to make this business’s RCS sender, and start paying for it: ${money(RCS_FIRST_YEAR_CENTS)} for the first year (${RCS_FIRST_YEAR_LINES.map((l) => `${l.name} ${money(l.cents)}${l.passedOn ? ', passed on at cost' : ''}`).join('; ')}), then ${money(RCS_YEARLY_CENTS)} a year. The worker makes the Stripe page; read its address from phone.setup_status. Asking again while one is waiting to be paid picks that one back up.`,
  risk: 3,
  input: RcsRequestSubmitInput,
  output: RcsRequestRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_request.submitted'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const sender = await currentRcsSender(ctx.tx, workspaceId);
    if (sender && sender.status !== 'failed')
      throw HfosError.rule(
        'rcs_sender_exists',
        409,
        'This business already has an RCS sender, so there’s nothing to ask for. It’s under RCS messaging in Settings → Texting & calls.',
      );
    const live = await liveRcsRequest(ctx.tx, workspaceId);
    if (live?.status === 'paid')
      throw HfosError.rule(
        'rcs_request_paid',
        409,
        `RCS for this business is already paid for. We’re making your sender and will connect it here. To change anything you sent, tell us with Get help${live.ticketNumber ? ` and mention ticket #${live.ticketNumber}` : ''}.`,
      );
    // A second press of Pay, or coming back to a page left open: the same request, not a second one.
    if (live) return refOf(live);

    // RCS rides on texting: a phone that can't show RCS gets the same message as a text from a business number.
    const [claimed] = await ctx.tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, workspaceId),
          inArray(phoneNumbers.status, [...CLAIMED_STATUSES]),
        ),
      )
      .limit(1);
    const [coming] = claimed
      ? [claimed]
      : await ctx.tx
          .select({ id: numberImports.id })
          .from(numberImports)
          .where(
            and(eq(numberImports.workspaceId, workspaceId), eq(numberImports.status, 'waiting')),
          )
          .limit(1);
    if (!coming)
      throw HfosError.rule(
        'no_number',
        409,
        'RCS needs a business number first: phones that can’t show RCS get your messages as ordinary texts from it. Get one, or bring yours, under Settings → Texting & calls, then ask for RCS.',
      );

    const [made] = await ctx.tx
      .insert(rcsRequests)
      .values({
        workspaceId,
        brand: input.brand,
        firstYearCents: RCS_FIRST_YEAR_CENTS,
        yearlyCents: RCS_YEARLY_CENTS,
        requestedBy: userIdOf(ctx.actor),
      })
      .returning();
    if (!made) throw HfosError.forbidden();
    await ctx.emit({
      type: 'rcs_request.submitted',
      entityType: 'rcs_request',
      entityId: made.id,
      payload: { rcsRequestId: made.id, firstYearCents: made.firstYearCents },
      after: {
        name: input.brand.displayName,
        firstYear: money(made.firstYearCents),
        yearly: money(made.yearlyCents),
      },
    });
    return refOf(made);
  },
});

export const rcsRequestCancel = defineCommand({
  name: 'rcs_request.cancel',
  description:
    'Give up on an RCS request that hasn’t been paid, or stop a paid one renewing: RCS stays on until the year paid for ends, nothing more is charged, and support is told so they can take the sender down then.',
  risk: 2,
  input: RcsRequestWorkspaceInput,
  output: RcsRequestRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_request.cancelled', 'rcs_request.stopped', 'support_ticket.opened'],
  async handler(ctx) {
    const workspaceId = ctx.scope.workspaceId!;
    const live = await liveRcsRequest(ctx.tx, workspaceId);
    if (!live)
      throw HfosError.notFound(
        'There’s no RCS request to stop. Refresh Settings → Texting & calls to see where RCS stands.',
      );
    const now = new Date();
    if (live.status !== 'paid') {
      await ctx.tx
        .update(rcsRequests)
        .set({ status: 'cancelled', closedAt: now })
        .where(eq(rcsRequests.id, live.id));
      await ctx.emit({
        type: 'rcs_request.cancelled',
        entityType: 'rcs_request',
        entityId: live.id,
        payload: { rcsRequestId: live.id, sessionRef: live.sessionRef },
        before: { status: live.status },
        after: { status: 'cancelled' },
      });
      return { rcsRequestId: live.id, status: 'cancelled' as const, checkoutUrl: null };
    }

    const by = userIdOf(ctx.actor);
    await ctx.tx
      .update(rcsRequests)
      .set({ stoppedAt: now, stoppedBy: by })
      .where(eq(rcsRequests.id, live.id));
    const business = await workspaceName(ctx.tx, workspaceId);
    const until = live.paidThrough ? longDate(live.paidThrough) : 'the end of the year paid for';
    // In the person's own name, through the same door as Get help: support has to take the sender down at
    // Twilio once the year ends, or Aegis bills its vetting again.
    const [ticket] = await rows<{ ticket_id: string; ticket_number: number | string }>(
      ctx.tx,
      sql`select ticket_id, ticket_number from private.open_support_ticket(
            ${workspaceId}, ${`Stop renewing RCS for ${business}`},
            ${[
              `Please stop renewing RCS for ${business}. It’s paid through ${until}, so it can stay on until then.`,
              '',
              `After ${until}, take our RCS sender down at Twilio so nothing more is billed for it.`,
              ...(live.ticketNumber ? ['', `It was set up on ticket #${live.ticketNumber}.`] : []),
            ].join('\n')},
            ${JSON.stringify({ page: 'Settings → Texting & calls → RCS messaging', platform: 'web' })}::jsonb)`,
    );
    await ctx.emit({
      type: 'rcs_request.stopped',
      entityType: 'rcs_request',
      entityId: live.id,
      payload: { rcsRequestId: live.id, paidThrough: live.paidThrough?.toISOString() ?? null },
      before: { renews: 'yes' },
      after: { renews: 'no', until },
    });
    if (ticket)
      await ctx.emit({
        type: 'support_ticket.opened',
        entityType: 'support_ticket',
        entityId: ticket.ticket_id,
        payload: { number: Number(ticket.ticket_number), channel: 'in_app' },
        after: { ticket: `#${Number(ticket.ticket_number)}` },
      });
    return refOf(live);
  },
});

export const rcsRequestPayRenewal = defineCommand({
  name: 'rcs_request.pay_renewal',
  description:
    'Pay RCS’s yearly renewal with another card, after the card on file refused it. The worker makes the Stripe page; read its address from phone.setup_status (rcsRequest.renewalCheckoutUrl). The new card is the one charged from then on.',
  risk: 3,
  input: RcsRequestWorkspaceInput,
  output: RcsRequestPayRenewalOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_request.renewal_page_requested'],
  async handler(ctx) {
    const live = await liveRcsRequest(ctx.tx, ctx.scope.workspaceId!);
    if (live?.status !== 'paid' || !live.renewalFailedAt || !live.paidThrough)
      throw HfosError.rule(
        'rcs_renewal_not_due',
        409,
        'There’s no RCS renewal waiting to be paid. Refresh Settings → Texting & calls to see where RCS stands.',
      );
    // The page already made for this year: the same one, not a second.
    if (live.renewalSessionUrl && live.renewalSessionFor?.getTime() === live.paidThrough.getTime())
      return { rcsRequestId: live.id, checkoutUrl: live.renewalSessionUrl };
    await ctx.emit({
      type: 'rcs_request.renewal_page_requested',
      entityType: 'rcs_request',
      entityId: live.id,
      payload: { rcsRequestId: live.id, forPaidThrough: live.paidThrough.toISOString() },
      after: { renewal: money(live.yearlyCents) },
    });
    return { rcsRequestId: live.id, checkoutUrl: null };
  },
});

// ---------- the worker's ----------

export const rcsRequestRecordRenewalPage = defineCommand({
  name: 'rcs_request.record_renewal_page',
  description: 'Worker: the Stripe page to pay a refused RCS renewal with another card is made.',
  risk: 1,
  input: RcsRequestRecordRenewalPageInput,
  output: RcsRequestRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const done = await ctx.tx
      .update(rcsRequests)
      .set({
        renewalSessionRef: input.sessionRef,
        renewalSessionUrl: input.url,
        renewalSessionFor: new Date(input.forPaidThrough),
      })
      .where(
        and(
          eq(rcsRequests.id, input.rcsRequestId),
          eq(rcsRequests.workspaceId, ctx.scope.workspaceId!),
          eq(rcsRequests.status, 'paid'),
          eq(rcsRequests.paidThrough, new Date(input.forPaidThrough)),
        ),
      )
      .returning({ id: rcsRequests.id });
    return {
      rcsRequestId: input.rcsRequestId,
      outcome: done.length ? ('recorded' as const) : ('unchanged' as const),
    };
  },
});

export const rcsRequestRecordOpened = defineCommand({
  name: 'rcs_request.record_opened',
  description: 'Worker: the Stripe page for an RCS request is made. Written once.',
  risk: 1,
  input: RcsRequestRecordOpenedInput,
  output: RcsRequestRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const done = await ctx.tx
      .update(rcsRequests)
      .set({
        status: 'open',
        sessionRef: input.sessionRef,
        sessionUrl: input.url,
        sessionExpiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        openedAt: new Date(),
      })
      .where(
        and(
          eq(rcsRequests.id, input.rcsRequestId),
          eq(rcsRequests.workspaceId, ctx.scope.workspaceId!),
          eq(rcsRequests.status, 'pending'),
        ),
      )
      .returning({ id: rcsRequests.id });
    return {
      rcsRequestId: input.rcsRequestId,
      outcome: done.length ? ('recorded' as const) : ('unchanged' as const),
    };
  },
});

export const rcsRequestRecordClosed = defineCommand({
  name: 'rcs_request.record_closed',
  description:
    'Worker: an RCS request’s Stripe page closed without being paid, or could not be made.',
  risk: 1,
  input: RcsRequestRecordClosedInput,
  output: RcsRequestRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['rcs_request.closed'],
  actors: ['system'],
  async handler(ctx, input) {
    const done = await ctx.tx
      .update(rcsRequests)
      .set({ status: input.status, problem: input.problem, closedAt: new Date() })
      .where(
        and(
          eq(rcsRequests.id, input.rcsRequestId),
          eq(rcsRequests.workspaceId, ctx.scope.workspaceId!),
          sql`${rcsRequests.status} in ('pending', 'open')`,
        ),
      )
      .returning({ id: rcsRequests.id });
    if (!done.length) return { rcsRequestId: input.rcsRequestId, outcome: 'unchanged' as const };
    await ctx.emit({
      type: 'rcs_request.closed',
      entityType: 'rcs_request',
      entityId: input.rcsRequestId,
      payload: { rcsRequestId: input.rcsRequestId, status: input.status },
      after: { status: input.status },
    });
    return { rcsRequestId: input.rcsRequestId, outcome: 'recorded' as const };
  },
});

export const rcsRequestRecordPaid = defineCommand({
  name: 'rcs_request.record_paid',
  description:
    'Worker: Stripe says an RCS request was paid for. The year starts, the card is kept for the renewal, and a support ticket opens for HandsFreeOS to make the sender.',
  risk: 3,
  input: RcsRequestRecordPaidInput,
  output: RcsRequestRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['rcs_request.paid', 'support_ticket.opened'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [r] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.rcs_requests where id = ${input.rcsRequestId}
            and workspace_id = ${workspaceId} for update`,
    );
    if (!r) throw HfosError.notFound('No RCS request with that id.');
    const [request] = await ctx.tx.select().from(rcsRequests).where(eq(rcsRequests.id, r.id));
    if (!request) throw HfosError.notFound('No RCS request with that id.');
    if (request.status === 'paid') return { rcsRequestId: request.id, outcome: 'already' as const };

    /*
     * **The money is in, whatever the page said since.** A request given up on, or a page that ran out, can still
     * be paid in a tab left open, and the payment is real. It is recorded; and when the business has meanwhile
     * started another request, that one gives way if unpaid, or — paid twice — this one is kept from renewing
     * and the ticket says to refund it.
     */
    const [other] = await ctx.tx
      .select()
      .from(rcsRequests)
      .where(
        and(
          eq(rcsRequests.workspaceId, workspaceId),
          ne(rcsRequests.id, request.id),
          sql`(${rcsRequests.status} in ('pending', 'open') or (${rcsRequests.status} = 'paid' and ${rcsRequests.stoppedAt} is null))`,
        ),
      );
    const paidTwice = other?.status === 'paid';
    if (other && !paidTwice)
      await ctx.tx
        .update(rcsRequests)
        .set({ status: 'cancelled', closedAt: new Date() })
        .where(eq(rcsRequests.id, other.id));

    const paidAt = new Date();
    const paidThrough = yearAfter(paidAt);
    const business = await workspaceName(ctx.tx, workspaceId);
    const [account] = await ctx.tx
      .select({ accountSid: telephonyAccounts.accountSid, status: telephonyAccounts.status })
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    const subaccount =
      account?.accountSid && account.status !== 'closed'
        ? `in their Twilio subaccount ${account.accountSid}`
        : 'in their Twilio subaccount, which doesn’t exist yet: turn on Phone & texting for them first (Settings → Texting & calls)';
    const lines = RCS_FIRST_YEAR_LINES.map((l) => `${l.name}: ${money(l.cents)}`).join(', ');
    const ticket = await openTicket(ctx, {
      requestedBy: request.requestedBy,
      subject: `RCS sender for ${business}${paidTwice ? ' (paid twice)' : ''}`,
      customer: [
        `We’d like RCS for ${business}. We paid ${money(input.paidCents)} for the first year.`,
        '',
        ...brandLines(request.brand),
      ].join('\n'),
      note: [
        ...(paidTwice
          ? [
              `This business had already paid for RCS (ticket #${other.ticketNumber ?? '—'}). Refund this payment (${input.paymentRef ?? 'see Stripe'}) in Stripe; it won’t renew.`,
              '',
            ]
          : []),
        `Paid ${money(input.paidCents)} on ${longDate(paidAt)} (${lines}). Stripe payment: ${input.paymentRef ?? '—'}.`,
        `Renews for ${money(request.yearlyCents)} on ${longDate(paidThrough)}${input.cardRef ? ', charged to the card they paid with' : '. No card was kept, so bill the renewal by hand'}.`,
        '',
        `1. Make the RCS sender in the Twilio console, ${subaccount}, under Messaging → Senders, with the details above. Ask on this ticket for the logo (224 × 224) and banner (1440 × 448) if they’re missing.`,
        '2. Send it for carrier review.',
        '3. Connect it under Settings → Texting & calls → RCS messaging while viewing their business. Its id is on the sender’s page, like lonestar_hvac_agent.',
        '4. Tell them here that it’s with the carriers. They get an email when it’s approved.',
      ].join('\n'),
      context: { kind: 'rcs_request', rcsRequestId: request.id },
    });
    await ctx.tx
      .update(rcsRequests)
      .set({
        status: 'paid',
        sessionRef: request.sessionRef ?? input.sessionRef,
        paymentRef: input.paymentRef,
        paidCents: input.paidCents,
        customerRef: input.customerRef,
        cardRef: input.cardRef,
        paidAt,
        paidThrough,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        problem: '',
        closedAt: null,
        ...(paidTwice ? { stoppedAt: paidAt } : {}),
      })
      .where(eq(rcsRequests.id, request.id));
    await ctx.emit({
      type: 'rcs_request.paid',
      entityType: 'rcs_request',
      entityId: request.id,
      payload: {
        rcsRequestId: request.id,
        paidCents: input.paidCents,
        paymentRef: input.paymentRef,
        ticketNumber: ticket.number,
        paidTwice,
      },
      before: { status: request.status },
      after: { status: 'paid', paid: money(input.paidCents), ticket: `#${ticket.number}` },
    });
    await ctx.emit({
      type: 'support_ticket.opened',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, channel: 'in_app' },
      after: { ticket: `#${ticket.number}` },
    });
    return { rcsRequestId: request.id, outcome: 'recorded' as const };
  },
});

export const rcsRequestRecordRenewal = defineCommand({
  name: 'rcs_request.record_renewal',
  description:
    'Worker: what the yearly RCS renewal charge did. Renewed moves the paid year on; a refused card is kept for support, who are told on a ticket, and nothing is charged again until they sort it out.',
  risk: 3,
  input: RcsRequestRecordRenewalInput,
  output: RcsRequestRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['rcs_request.renewed', 'rcs_request.renewal_failed', 'support_ticket.opened'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [locked] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.rcs_requests where id = ${input.rcsRequestId}
            and workspace_id = ${workspaceId} for update`,
    );
    if (!locked) throw HfosError.notFound('No RCS request with that id.');
    const [r] = await ctx.tx.select().from(rcsRequests).where(eq(rcsRequests.id, locked.id));
    if (!r || r.status !== 'paid' || !r.paidThrough)
      return { rcsRequestId: input.rcsRequestId, outcome: 'unchanged' as const };
    // The year this answer is about has already moved on (a retry, or an answer arriving twice).
    if (r.paidThrough.toISOString() !== new Date(input.forPaidThrough).toISOString())
      return { rcsRequestId: r.id, outcome: 'already' as const };

    if (input.outcome === 'renewed') {
      const next = yearAfter(r.paidThrough);
      await ctx.tx
        .update(rcsRequests)
        .set({
          paidThrough: next,
          renewalCount: r.renewalCount + 1,
          renewalProblem: null,
          renewalFailedAt: null,
          // Paid with another card on a page of its own: that card is next year's.
          ...(input.cardRef ? { cardRef: input.cardRef } : {}),
          ...(input.customerRef ? { customerRef: input.customerRef } : {}),
        })
        .where(eq(rcsRequests.id, r.id));
      await ctx.emit({
        type: 'rcs_request.renewed',
        entityType: 'rcs_request',
        entityId: r.id,
        payload: {
          rcsRequestId: r.id,
          paidCents: input.paidCents,
          paymentRef: input.paymentRef,
          paidThrough: next.toISOString(),
        },
        after: { paid: money(input.paidCents ?? r.yearlyCents), until: longDate(next) },
      });
      return { rcsRequestId: r.id, outcome: 'recorded' as const };
    }

    if (r.renewalFailedAt) return { rcsRequestId: r.id, outcome: 'already' as const };
    const business = await workspaceName(ctx.tx, workspaceId);
    const problem = input.problem ?? 'The card was declined.';
    const ticket = await openTicket(ctx, {
      requestedBy: r.requestedBy,
      subject: `RCS renewal for ${business} didn’t go through`,
      customer: `The yearly ${money(r.yearlyCents)} RCS renewal for ${business} didn’t go through: ${problem} We can pay it with another card under RCS messaging in Settings → Texting & calls.`,
      note: [
        `The renewal due ${longDate(r.paidThrough)} was refused (${problem}). Nothing is charged again automatically.`,
        'They can pay it with another card from the RCS card in Settings, which renews it and keeps that card for next year. RCS stays connected meanwhile.',
        ...(r.ticketNumber ? [`RCS was set up on ticket #${r.ticketNumber}.`] : []),
      ].join('\n'),
      context: { kind: 'rcs_renewal', rcsRequestId: r.id },
    });
    await ctx.tx
      .update(rcsRequests)
      .set({ renewalProblem: problem, renewalFailedAt: new Date() })
      .where(eq(rcsRequests.id, r.id));
    await ctx.emit({
      type: 'rcs_request.renewal_failed',
      entityType: 'rcs_request',
      entityId: r.id,
      payload: { rcsRequestId: r.id, problem, ticketNumber: ticket.number },
      after: { renewal: 'refused', reason: problem.slice(0, 200) },
    });
    await ctx.emit({
      type: 'support_ticket.opened',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, channel: 'in_app' },
      after: { ticket: `#${ticket.number}` },
    });
    return { rcsRequestId: r.id, outcome: 'recorded' as const };
  },
});

export const rcsRequestCommands = [
  rcsRequestSubmit,
  rcsRequestCancel,
  rcsRequestPayRenewal,
  rcsRequestRecordOpened,
  rcsRequestRecordClosed,
  rcsRequestRecordPaid,
  rcsRequestRecordRenewal,
  rcsRequestRecordRenewalPage,
];
