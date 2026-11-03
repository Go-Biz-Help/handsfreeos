/**
 * What registering a local number for texting costs a business (0105), passed on at cost.
 *
 * `registration.submit` writes a registration's fees (`texting_fee.due`); the worker collects them, charging the
 * card the business paid with before or else making a Stripe page, and records what happened here. The 10DLC
 * steps wait until the fee is paid. Each month of an approved campaign is a fee of its own, written by the
 * worker's sweep (`texting_fee.charge_month`) and collected the same way. A business whose card said no pays on
 * a page with another card (`texting_fee.pay`), which becomes the card charged from then on.
 *
 * The money is only ever believed from Stripe's answer: the charge's own result, or the page's signed event.
 * `private.guard_texting_fee_update()` keeps what Stripe said the worker's to write.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { textingFees } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { money } from '../money/format';
import { isOurOwnBusiness } from '../messaging/store';
import { TEXTING_FEES } from '../money/texting-fees';
import {
  TextingFeeChargeMonthInput,
  TextingFeePayInput,
  TextingFeePayOutput,
  TextingFeeRecordOutcomeInput,
  TextingFeeRecordOutput,
  TextingFeeRecordPageInput,
} from '../schemas/texting-fee';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const UNSETTLED = ['pending', 'open', 'failed'] as const;

export const textingFeePay = defineCommand({
  name: 'texting_fee.pay',
  description:
    'Pay a texting fee on a Stripe page with another card: a registration’s fees the card said no to, or a month of the campaign. The worker makes the page; read its address from phone.setup_status (textingFees). The card paid with is the one charged from then on. For HandsFreeOS’s own business, which is never charged, the worker lets the fee through instead.',
  risk: 3,
  input: TextingFeePayInput,
  output: TextingFeePayOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['texting_fee.page_requested'],
  async handler(ctx, input) {
    const [f] = await ctx.tx
      .select()
      .from(textingFees)
      .where(
        and(
          eq(textingFees.id, input.textingFeeId),
          eq(textingFees.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!f || !(UNSETTLED as readonly string[]).includes(f.status))
      throw HfosError.rule(
        'texting_fee_settled',
        409,
        'There’s nothing to pay for texting right now. Refresh Settings → Texting & calls to see where it stands.',
      );
    // HandsFreeOS's own business is never charged: the worker lets this one through instead of making a page.
    const ours = await isOurOwnBusiness(ctx.tx, ctx.scope.workspaceId!);
    // A page already waiting: the same one. One being collected: it is moments from a page or a charge.
    if (f.status === 'open' && !ours) return { textingFeeId: f.id, checkoutUrl: f.sessionUrl };
    if (f.status === 'pending' && !ours) return { textingFeeId: f.id, checkoutUrl: null };
    await ctx.emit({
      type: 'texting_fee.page_requested',
      entityType: 'texting_fee',
      entityId: f.id,
      payload: { textingFeeId: f.id },
      after: { paying: money(f.amountCents) },
    });
    return { textingFeeId: f.id, checkoutUrl: null };
  },
});

// ---------- the worker's ----------

export const textingFeeRecordPage = defineCommand({
  name: 'texting_fee.record_page',
  description: 'Worker: the Stripe page to pay a texting fee on is made.',
  risk: 1,
  input: TextingFeeRecordPageInput,
  output: TextingFeeRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const done = await ctx.tx
      .update(textingFees)
      .set({
        status: 'open',
        sessionRef: input.sessionRef,
        sessionUrl: input.url,
        sessionExpiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .where(
        and(
          eq(textingFees.id, input.textingFeeId),
          eq(textingFees.workspaceId, ctx.scope.workspaceId!),
          inArray(textingFees.status, ['pending', 'failed']),
        ),
      )
      .returning({ id: textingFees.id });
    return {
      textingFeeId: input.textingFeeId,
      outcome: done.length ? ('recorded' as const) : ('unchanged' as const),
    };
  },
});

export const textingFeeRecordOutcome = defineCommand({
  name: 'texting_fee.record_outcome',
  description:
    'Worker: what collecting a texting fee came to. Paid (or waived, when paying online is off) lets the registration go to the carriers; failed waits for the business to pay with another card.',
  risk: 3,
  input: TextingFeeRecordOutcomeInput,
  output: TextingFeeRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['texting_fee.paid', 'texting_fee.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [locked] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.texting_fees where id = ${input.textingFeeId}
            and workspace_id = ${workspaceId} for update`,
    );
    if (!locked) throw HfosError.notFound('No texting fee with that id.');
    const [f] = await ctx.tx.select().from(textingFees).where(eq(textingFees.id, locked.id));
    if (!f) throw HfosError.notFound('No texting fee with that id.');
    if (f.status === 'paid' || f.status === 'waived')
      return { textingFeeId: f.id, outcome: 'already' as const };
    const now = new Date();

    if (input.status === 'failed') {
      // A late refusal never undoes a payment, and a fee put aside stays aside.
      if (f.status === 'cancelled') return { textingFeeId: f.id, outcome: 'unchanged' as const };
      await ctx.tx
        .update(textingFees)
        .set({
          status: 'failed',
          problem: input.problem ?? 'The card was declined.',
          // The page that ran out is spent: paying again makes a new one.
          sessionUrl: null,
        })
        .where(eq(textingFees.id, f.id));
      if (f.status !== 'failed')
        await ctx.emit({
          type: 'texting_fee.failed',
          entityType: 'texting_fee',
          entityId: f.id,
          payload: { textingFeeId: f.id, purpose: f.purpose, problem: input.problem },
          after: { unpaid: money(f.amountCents), reason: (input.problem ?? '').slice(0, 200) },
        });
      return { textingFeeId: f.id, outcome: 'recorded' as const };
    }

    // Paid, or let through uncharged. Money that arrives for a fee put aside is still real: it is recorded,
    // and settles the fee that carried its lines, when that one asks for nothing more.
    await ctx.tx
      .update(textingFees)
      .set({
        status: input.status,
        paymentRef: input.paymentRef,
        paidCents: input.paidCents,
        customerRef: input.customerRef,
        cardRef: input.cardRef,
        paidAt: input.status === 'paid' ? now : null,
        problem: input.problem ?? '',
        closedAt: now,
      })
      .where(eq(textingFees.id, f.id));
    if (f.status === 'cancelled' && f.purpose === 'registration') {
      const [carrier] = await ctx.tx
        .select()
        .from(textingFees)
        .where(
          and(
            eq(textingFees.workspaceId, workspaceId),
            eq(textingFees.purpose, 'registration'),
            inArray(textingFees.status, [...UNSETTLED]),
          ),
        );
      const paidFor = new Set(f.lines.map((l) => l.key));
      if (carrier && carrier.lines.every((l) => paidFor.has(l.key)))
        await ctx.tx
          .update(textingFees)
          .set({
            status: input.status,
            paymentRef: input.paymentRef,
            paidCents: 0,
            paidAt: input.status === 'paid' ? now : null,
            problem: 'Paid on an earlier page.',
            closedAt: now,
          })
          .where(eq(textingFees.id, carrier.id));
    }
    await ctx.emit({
      type: 'texting_fee.paid',
      entityType: 'texting_fee',
      entityId: f.id,
      payload: {
        textingFeeId: f.id,
        purpose: f.purpose,
        status: input.status,
        paidCents: input.paidCents,
        paymentRef: input.paymentRef,
      },
      after:
        input.status === 'paid'
          ? { paid: money(input.paidCents ?? f.amountCents) }
          : { waived: money(f.amountCents) },
    });
    return { textingFeeId: f.id, outcome: 'recorded' as const };
  },
});

export const textingFeeChargeMonth = defineCommand({
  name: 'texting_fee.charge_month',
  description: 'Worker: a month of an approved texting campaign has started, so its fee is owed.',
  risk: 1,
  input: TextingFeeChargeMonthInput,
  output: TextingFeeRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['texting_fee.due'],
  actors: ['system'],
  async handler(ctx, input) {
    const line = TEXTING_FEES.campaign_month;
    const [made] = await ctx.tx
      .insert(textingFees)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        purpose: 'month',
        lines: [{ key: line.key, name: line.name, cents: line.cents }],
        amountCents: line.cents,
        registrationId: input.registrationId,
        monthIndex: input.monthIndex,
        periodStart: new Date(input.periodStart),
      })
      .onConflictDoNothing()
      .returning({ id: textingFees.id });
    if (!made) return { textingFeeId: null, outcome: 'already' as const };
    await ctx.emit({
      type: 'texting_fee.due',
      entityType: 'texting_fee',
      entityId: made.id,
      payload: { textingFeeId: made.id, amountCents: line.cents, purpose: 'month' },
      after: { owed: money(line.cents), for: line.name },
    });
    return { textingFeeId: made.id, outcome: 'recorded' as const };
  },
});

export const textingFeeCommands = [
  textingFeePay,
  textingFeeRecordPage,
  textingFeeRecordOutcome,
  textingFeeChargeMonth,
];
