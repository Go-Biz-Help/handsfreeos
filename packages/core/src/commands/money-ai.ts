/**
 * Money the AI teammate asks for (M18): a bill or a quote from the price list, a customer's answer to a quote, a
 * maintenance plan. (Resending a bill or a quote already sent is only a message with its link.) None
 * of it happens on the teammate's say-so. Each is held in an **approval** draft that only an owner or admin can
 * decide, in every mode, and these commands run when `ai_teammate.send_draft` carries it out, as the teammate
 * with the approver on the actor. Without that approver they refuse.
 *
 * Like its bookings, the customer is always the one in the conversation the teammate is answering, never an id
 * the model gave; what a bill or a quote charges comes from the catalogue, never from the model; and a website
 * chat gets none of it until its visitor has proved who they are with a code. Each command does what the person's own
 * command does (the shared `createInvoice`, `sendEstimate`, `startSubscription`…), so a document the teammate
 * sends is the same document a person would have sent.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { plans, products } from '@hfos/db/schema';
import {
  chatIdentityUnverified,
  chatVerified,
  notHandledByAi,
  outsideItsConversation,
} from '../ai-team/reach';
import type { TeammateConfig } from '../ai-team/config';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { AiEmployeeActor, CommandContext } from '../kernel/types';
import { loadConversation } from '../messaging/store';
import {
  EstimateAnswerForCustomerInput,
  EstimateCreateForCustomerInput,
  InvoiceCreateForCustomerInput,
  SubscriptionStartForCustomerInput,
  type CatalogueLine,
} from '../schemas/ai-team';
import {
  EstimateAcceptedOutput,
  EstimateStateOutput,
  InvoiceStateOutput,
  SubscriptionCardOutput,
} from '../schemas/money';
import { createEstimate, declineEstimate, recordStaffAcceptance, sendEstimate } from './estimate';
import { createInvoice, sendInvoice } from './invoice';
import { requireEstimate } from './money-shared';
import { requestPlanCard, startSubscription } from './subscription';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

interface Approved {
  readonly ai: AiEmployeeActor;
  /** The owner or admin whose OK this runs on. */
  readonly approver: string;
  readonly personId: string;
  readonly leadId: string | null;
  /** How the customer is written to: the conversation's channel. */
  readonly channel: 'sms' | 'email';
  readonly config: TeammateConfig;
}

/**
 * The teammate, with an owner's or admin's OK, acting for the customer in its conversation. The approver must
 * still be someone who manages money in this business: a draft decided by someone who has since lost that role
 * doesn't go out.
 */
async function approvedFor(ctx: CommandContext): Promise<Approved> {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai) throw HfosError.forbidden('Only the AI teammate asks for money this way.');
  if (!ai.approvedBy)
    throw HfosError.forbidden(
      'An owner or admin approves anything with money in it before the AI teammate sends it.',
      'money_needs_approval',
    );
  const ws = ctx.scope.workspaceId!;
  // Whoever approved it still manages money here, as the business has set it (0105).
  const [approver] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.user_has_permission(${ai.approvedBy}::uuid, ${ws}::uuid, 'money.manage') as ok`,
  );
  if (!approver?.ok)
    throw HfosError.forbidden(
      'Whoever approved this no longer manages money here, so it didn’t go out.',
      'money_needs_approval',
    );
  if (!ai.conversationId) throw outsideItsConversation();
  const conv = await loadConversation(ctx, ai.conversationId);
  if (conv.handledBy !== 'ai' || conv.aiTeammateId !== ai.teammateId) throw notHandledByAi();
  if (!(await chatVerified(ctx.tx, conv))) throw chatIdentityUnverified();
  if (!conv.personId) throw outsideItsConversation();
  const row = await loadTeammate(ctx.tx, ws, { teammateId: ai.teammateId });
  if (!row) throw outsideItsConversation();
  // The customer's open lead, newest first, for the document to hang off.
  const [lead] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.leads
        where workspace_id = ${ws} and person_id = ${conv.personId} and status = 'open' and archived_at is null
        order by created_at desc limit 1`,
  );
  return {
    ai,
    approver: ai.approvedBy,
    personId: conv.personId,
    leadId: lead?.id ?? null,
    channel: conv.channel === 'email' ? 'email' : 'sms',
    config: teammateConfigOf(row),
  };
}

const notAllowed = (what: string) =>
  HfosError.rule(
    'money_not_allowed',
    409,
    `The AI teammate’s settings don’t let it ${what}. Someone on the team can.`,
  );

const notTheirs = (what: string) =>
  HfosError.forbidden(`That ${what} isn’t this customer’s.`, 'not_this_customer');

/**
 * Lines from the catalogue, priced as the catalogue prices them today. The model names a product and a quantity;
 * what it costs is never its to say.
 */
async function catalogueLines(tx: Tx, workspaceId: string, lines: readonly CatalogueLine[]) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const found = await tx
    .select()
    .from(products)
    .where(
      and(
        eq(products.workspaceId, workspaceId),
        inArray(products.id, ids),
        isNull(products.archivedAt),
      ),
    );
  const byId = new Map(found.map((p) => [p.id, p]));
  return lines.map((l, i) => {
    const p = byId.get(l.productId);
    if (!p)
      throw HfosError.validation([
        { path: `lines.${i}.productId`, message: 'That isn’t on the price list.' },
      ]);
    return {
      productId: p.id,
      name: p.name,
      description: p.description ?? null,
      quantity: l.quantity,
      unitLabel: p.unitLabel,
      unitPriceCents: Number(p.unitPriceCents),
      taxable: p.taxable,
      discountCents: 0,
    };
  });
}

export const invoiceCreateForCustomer = defineCommand({
  name: 'invoice.create_for_customer',
  description:
    'With an owner’s or admin’s OK, the AI teammate bills the customer it’s talking to for things on the price list, at the price list’s prices, and sends it with the link they pay on.',
  risk: 2,
  input: InvoiceCreateForCustomerInput,
  output: InvoiceStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['invoice.created', 'invoice.sent'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const a = await approvedFor(ctx);
    if (!a.config.money.newBills) throw notAllowed('put bills together');
    const lines = await catalogueLines(ctx.tx, input.workspaceId, input.lines);
    const made = await createInvoice(
      ctx,
      {
        workspaceId: input.workspaceId,
        personId: a.personId,
        leadId: a.leadId,
        title: input.title,
        lines,
        purpose: 'standard',
        origin: 'ai_teammate',
      },
      a.approver,
    );
    return sendInvoice(ctx, {
      workspaceId: input.workspaceId,
      invoiceId: made.invoiceId,
      channels: [a.channel],
      message: null,
    });
  },
});

export const estimateCreateForCustomer = defineCommand({
  name: 'estimate.create_for_customer',
  description:
    'With an owner’s or admin’s OK, the AI teammate quotes the customer it’s talking to for things on the price list, at the price list’s prices, and sends it with the link they answer it on.',
  risk: 2,
  input: EstimateCreateForCustomerInput,
  output: EstimateStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['estimate.created', 'estimate.sent'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const a = await approvedFor(ctx);
    if (a.config.money.quotes !== 'build') throw notAllowed('put quotes together');
    const lines = await catalogueLines(ctx.tx, input.workspaceId, input.lines);
    const made = await createEstimate(
      ctx,
      {
        workspaceId: input.workspaceId,
        personId: a.personId,
        leadId: a.leadId,
        title: input.title,
        lines,
      },
      a.approver,
    );
    return sendEstimate(ctx, {
      workspaceId: input.workspaceId,
      estimateId: made.estimateId,
      channels: [a.channel],
      message: null,
    });
  },
});

export const estimateAnswerForCustomer = defineCommand({
  name: 'estimate.answer_for_customer',
  description:
    'With an owner’s or admin’s OK, the AI teammate records the answer the customer it’s talking to gave to their quote in the conversation. A yes is recorded as staff, in the approver’s name, never as the customer’s own approval on their page.',
  risk: 2,
  input: EstimateAnswerForCustomerInput,
  output: EstimateAcceptedOutput.or(EstimateStateOutput),
  permission: null,
  scope: inWorkspace,
  emits: ['estimate.accepted', 'estimate.declined'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const a = await approvedFor(ctx);
    if (a.config.money.quotes === 'off') throw notAllowed('record answers to quotes');
    const estimate = await requireEstimate(ctx, input.estimateId);
    if (estimate.person_id !== a.personId) throw notTheirs('quote');
    const told = a.channel === 'sms' ? 'by text' : 'by email';
    if (input.accepted)
      return recordStaffAcceptance(
        ctx,
        {
          workspaceId: input.workspaceId,
          estimateId: estimate.id,
          name: input.name,
          note: `Told ${a.ai.teammateName} ${told}`,
        },
        a.approver,
      );
    return declineEstimate(
      ctx,
      {
        workspaceId: input.workspaceId,
        estimateId: estimate.id,
        name: input.name,
        reason: input.reason ?? null,
      },
      { onTheirPage: false },
    );
  },
});

export const subscriptionStartForCustomer = defineCommand({
  name: 'subscription.start_for_customer',
  description:
    'With an owner’s or admin’s OK, the AI teammate signs the customer it’s talking to up for one of the business’s maintenance plans, at its price today. The plan waits for a card, and the customer gets the link to add one.',
  risk: 2,
  input: SubscriptionStartForCustomerInput,
  output: SubscriptionCardOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['subscription.started', 'subscription.card_requested'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const a = await approvedFor(ctx);
    if (!a.config.money.plans) throw notAllowed('sign customers up for plans');
    const [plan] = await ctx.tx
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.id, input.planId),
          eq(plans.workspaceId, input.workspaceId),
          isNull(plans.archivedAt),
        ),
      );
    if (!plan)
      throw HfosError.validation([{ path: 'planId', message: 'That isn’t one of your plans.' }]);
    const started = await startSubscription(
      ctx,
      { workspaceId: input.workspaceId, personId: a.personId, planId: plan.id, leadId: a.leadId },
      a.approver,
    );
    return requestPlanCard(ctx, {
      workspaceId: input.workspaceId,
      subscriptionId: started.subscriptionId,
      channels: [a.channel],
      message: null,
    });
  },
});
