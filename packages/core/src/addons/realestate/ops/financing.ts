/**
 * The financing tracker, step 11 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"). Chris
 * decided: the agent and coordinator mark each step, with proof: the lender's letter or email, or a document. The
 * lender's own connector comes later.
 *
 * - **Each step** (preapproval, application, rate lock, appraisal, conditional approval, clear to close, the Closing
 *   Disclosure, funding) keeps its dates, amount and rate as it goes, and is done only by a person, with its proof.
 * - **Dates the deal's duties rest on** come from it: a preapproval's or rate lock's end, and the day the Closing
 *   Disclosure was received, go to the deal's key dates (`realestate.term.enter`, from the lender).
 * - **The Closing Disclosure's deadline** is worked out from closing (`cdDeadline`), and a lock or preapproval that
 *   ends before closing, or an appraisal under the price, is pointed out.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  cdDeadline,
  FINANCING_STEP_KEYS,
  FINANCING_STEPS,
  stepWords,
  type FinancingStep,
} from '../closing';
import { realestateAddon } from '../manifest';
import {
  FinancingChangeOutput,
  FinancingInput,
  FinancingMarkDoneInput,
  FinancingOutput,
  FinancingReopenInput,
  FinancingSetLenderInput,
  FinancingUpdateStepInput,
  type StepProof,
} from '../schemas';
import { documents, financing, financingSteps } from '../tables';
import { moneyOf, termsNow, type TermKey } from '../terms';
import {
  actorKind,
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { termEntriesOf } from './engine';
import { requireBuyerSide } from './homes';
import { termEnter } from './terms';
import { documentProof, PROOF_EVENTS } from './proof-hooks';
import type { z } from 'zod';

type Step = typeof financingSteps.$inferSelect;
type Fields = {
  startedOn?: string | null | undefined;
  expectedOn?: string | null | undefined;
  amountCents?: number | null | undefined;
  rate?: number | null | undefined;
  expiresOn?: string | null | undefined;
  note?: string | null | undefined;
};

const label = (s: FinancingStep) => FINANCING_STEPS[s].label;

async function stepOf(ctx: Ctx, dealId: string, step: FinancingStep): Promise<Step | null> {
  const [row] = await ctx.tx
    .select()
    .from(financingSteps)
    .where(and(eq(financingSteps.dealRecordId, dealId), eq(financingSteps.step, step)))
    .for('update');
  return row ?? null;
}

const fieldsOf = (f: Fields) => ({
  ...(f.startedOn !== undefined ? { startedOn: f.startedOn } : {}),
  ...(f.expectedOn !== undefined ? { expectedOn: f.expectedOn } : {}),
  ...(f.amountCents !== undefined ? { amountCents: f.amountCents } : {}),
  ...(f.rate !== undefined ? { rate: f.rate === null ? null : f.rate.toString() } : {}),
  ...(f.expiresOn !== undefined ? { expiresOn: f.expiresOn } : {}),
  ...(f.note !== undefined ? { note: f.note } : {}),
});

/** Writes a step, making it when it's the first word of it. */
async function putStep(
  ctx: CommandContext,
  deal: Deal,
  step: FinancingStep,
  values: Partial<typeof financingSteps.$inferInsert>,
): Promise<Step> {
  const was = await stepOf(ctx, deal.recordId, step);
  const [row] = was
    ? await ctx.tx
        .update(financingSteps)
        .set({ ...values, updatedBy: actorUserId(ctx), updatedAt: new Date() })
        .where(eq(financingSteps.id, was.id))
        .returning()
    : await ctx.tx
        .insert(financingSteps)
        .values({
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          step,
          ...values,
          updatedBy: actorUserId(ctx),
        })
        .returning();
  return row!;
}

/** The proof is the deal's: one of its documents, a file on it, or a message in this business. */
async function proofLabel(
  ctx: Ctx,
  deal: Deal,
  proof: z.infer<typeof StepProof>,
): Promise<string | null> {
  if (proof.kind === 'document') {
    const [d] = await ctx.tx
      .select({ title: documents.title })
      .from(documents)
      .where(and(eq(documents.id, proof.id), eq(documents.dealRecordId, deal.recordId)));
    return d?.title ?? null;
  }
  if (proof.kind === 'file') {
    const [f] = await rows<{ name: string }>(
      ctx.tx,
      sql`select name from app.files where id = ${proof.id} and record_type = 'custom_record'
            and record_id = ${deal.recordId} and status = 'ready'`,
    );
    return f?.name ?? null;
  }
  const [m] = await rows<{ subject: string | null; counterpart: string }>(
    ctx.tx,
    sql`select m.subject, c.counterpart from app.messages m join app.conversations c on c.id = m.conversation_id
        where m.id = ${proof.id} and m.workspace_id = ${deal.workspaceId}`,
  );
  return m ? m.subject?.trim() || `Message from ${m.counterpart}` : null;
}

/** A date from a step that the deal's duties rest on, entered as the lender's when it's new. */
async function enterDate(
  ctx: CommandContext,
  deal: Deal,
  key: TermKey,
  date: string | null,
): Promise<number> {
  if (!date) return 0;
  const now = termsNow(await termEntriesOf(ctx, deal.recordId)).get(key);
  if (now?.current?.valueDate === date) return 0;
  await executeCommandWithin(ctx, termEnter, {
    workspaceId: deal.workspaceId,
    dealId: deal.recordId,
    key,
    date,
    source: 'lender',
    ...(now?.current ? { replaces: now.current.id } : {}),
  });
  return 1;
}

// ---------- commands ----------

export const financingSetLender = defineAddonCommand(realestateAddon, {
  name: 'realestate.financing.set_lender',
  description: 'Set a buyer deal’s lender, loan officer and loan.',
  risk: 1,
  input: FinancingSetLenderInput,
  output: FinancingChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.financing.changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireBuyerSide(deal);
    const values = {
      ...(input.lenderName !== undefined ? { lenderName: input.lenderName } : {}),
      ...(input.officerName !== undefined ? { officerName: input.officerName } : {}),
      ...(input.officerEmail !== undefined ? { officerEmail: input.officerEmail } : {}),
      ...(input.officerPhone !== undefined ? { officerPhone: input.officerPhone } : {}),
      ...(input.loanType !== undefined ? { loanType: input.loanType } : {}),
      ...(input.loanAmountCents !== undefined ? { loanAmountCents: input.loanAmountCents } : {}),
      updatedBy: actorUserId(ctx),
      updatedAt: new Date(),
    };
    await ctx.tx
      .insert(financing)
      .values({ workspaceId: deal.workspaceId, dealRecordId: deal.recordId, ...values })
      .onConflictDoUpdate({ target: [financing.workspaceId, financing.dealRecordId], set: values });
    await ctx.emit({
      type: 'realestate.financing.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { what: 'lender' },
    });
    return { dealId: deal.recordId, step: null, termsEntered: 0 };
  },
});

export const financingUpdateStep = defineAddonCommand(realestateAddon, {
  name: 'realestate.financing.update_step',
  description:
    'Keep where a financing step stands: when it started or is expected, the amount (preapproval, appraisal), the locked rate, when it ends, and a note.',
  risk: 1,
  input: FinancingUpdateStepInput,
  output: FinancingChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_update_financing',
    description:
      'Note where a buyer’s financing step stands (dates, amount, rate). It doesn’t mark it done.',
  },
  emits: ['realestate.financing.changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireBuyerSide(deal);
    const was = await stepOf(ctx, deal.recordId, input.step);
    await putStep(ctx, deal, input.step, {
      ...fieldsOf(input),
      ...(was?.status === 'done' ? {} : { status: 'in_progress' as const }),
    });
    await ctx.emit({
      type: 'realestate.financing.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { what: 'step', step: input.step },
    });
    return { dealId: deal.recordId, step: input.step, termsEntered: 0 };
  },
});

export const financingMarkDone = defineAddonCommand(realestateAddon, {
  name: 'realestate.financing.mark_done',
  description:
    'Mark a financing step done, with its proof: the lender’s letter or email, or one of the deal’s documents. Only a person marks a step done.',
  risk: 1,
  input: FinancingMarkDoneInput,
  output: FinancingChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.financing.step_done', ...PROOF_EVENTS],
  async handler(ctx, input) {
    if (actorKind(ctx) !== 'person')
      throw HfosError.forbidden(
        'Only a person marks a financing step done, with its proof, from the deal’s financing page.',
      );
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireBuyerSide(deal);
    const proof = await proofLabel(ctx, deal, input.proof);
    if (!proof)
      throw HfosError.rule(
        'realestate_step_proof',
        409,
        input.proof.kind === 'document'
          ? `That document isn’t on ${deal.name}. Upload the lender’s letter to the deal’s documents, then pick it.`
          : input.proof.kind === 'file'
            ? `That file isn’t on ${deal.name}, or it hasn’t finished uploading. Upload it to the deal, then pick it.`
            : 'That message isn’t in this business’s Inbox. Pick the lender’s email from the Inbox.',
      );
    const doneOn = input.doneOn ?? todayIn(await timeZoneOf(ctx));
    const row = await putStep(ctx, deal, input.step, {
      ...fieldsOf(input),
      status: 'done',
      doneOn,
      proofKind: input.proof.kind,
      proofId: input.proof.id,
      doneBy: actorUserId(ctx),
      doneAt: changeMoment(ctx.meta),
    });
    let termsEntered = 0;
    if (input.step === 'preapproval')
      termsEntered += await enterDate(ctx, deal, 'preapproval_expiry', row.expiresOn);
    if (input.step === 'rate_lock')
      termsEntered += await enterDate(ctx, deal, 'rate_lock_expiry', row.expiresOn);
    if (input.step === 'closing_disclosure')
      termsEntered += await enterDate(ctx, deal, 'cd_received', doneOn);
    await historyLine(ctx, deal, 'financing_step_done', { after: { step: input.step, proof } });
    // A lender's document counts for the duties that name its kind (B-02's preapproval, the rate lock…).
    if (input.proof.kind === 'document') await documentProof(ctx, deal, input.proof.id);
    await ctx.emit({
      type: 'realestate.financing.step_done',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        step: input.step,
        stepId: row.id,
        proofKind: input.proof.kind,
        proofId: input.proof.id,
      },
    });
    return { dealId: deal.recordId, step: input.step, termsEntered };
  },
});

export const financingReopen = defineAddonCommand(realestateAddon, {
  name: 'realestate.financing.reopen_step',
  description:
    'Take back a financing step marked done, with the reason. Kept in the deal’s history.',
  risk: 1,
  input: FinancingReopenInput,
  output: FinancingChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.financing.changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const was = await stepOf(ctx, deal.recordId, input.step);
    if (was?.status !== 'done')
      throw HfosError.rule(
        'realestate_step_not_done',
        409,
        `${label(input.step)} isn’t marked done on ${deal.name}, so there’s nothing to take back.`,
      );
    await putStep(ctx, deal, input.step, {
      status: 'in_progress',
      doneOn: null,
      proofKind: null,
      proofId: null,
      doneBy: null,
      doneAt: null,
    });
    await historyLine(ctx, deal, 'financing_step_reopened', {
      after: { step: input.step },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.financing.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { what: 'reopened', step: input.step },
    });
    return { dealId: deal.recordId, step: input.step, termsEntered: 0 };
  },
});

// ---------- the query ----------

export const financingGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.financing',
  description:
    'A buyer deal’s financing: the lender and loan, each step from preapproval to funding with its dates and proof, and the Closing Disclosure’s deadline.',
  input: FinancingInput,
  output: FinancingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_financing',
    description:
      'Where a buyer’s financing stands, step by step, and the Closing Disclosure’s deadline.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const [lender] = await ctx.tx
      .select()
      .from(financing)
      .where(eq(financing.dealRecordId, deal.recordId));
    const list = await ctx.tx
      .select()
      .from(financingSteps)
      .where(eq(financingSteps.dealRecordId, deal.recordId));
    const terms = termsNow(await termEntriesOf(ctx, deal.recordId));
    const closing = terms.get('closing')?.current?.valueDate ?? null;
    const priceCents = moneyOf(terms, 'price');
    const names = await userNames(
      ctx,
      list.map((s) => s.doneBy),
    );
    const proofs = new Map<string, string>();
    for (const s of list)
      if (s.proofKind && s.proofId)
        proofs.set(
          s.id,
          (await proofLabel(ctx, deal, { kind: s.proofKind, id: s.proofId })) ?? 'Removed since',
        );
    return {
      lender: {
        lenderName: lender?.lenderName ?? null,
        officerName: lender?.officerName ?? null,
        officerEmail: lender?.officerEmail ?? null,
        officerPhone: lender?.officerPhone ?? null,
        loanType: lender?.loanType ?? null,
        loanAmountCents: lender?.loanAmountCents ?? null,
      },
      closing,
      cdDeadline: closing ? cdDeadline(closing) : null,
      steps: FINANCING_STEP_KEYS.map((step) => {
        const s = list.find((x) => x.step === step);
        const facts = {
          step,
          status: s?.status ?? ('not_started' as const),
          startedOn: s?.startedOn ?? null,
          expectedOn: s?.expectedOn ?? null,
          doneOn: s?.doneOn ?? null,
          amountCents: s?.amountCents ?? null,
          rate: s?.rate === null || s?.rate === undefined ? null : Number(s.rate),
          expiresOn: s?.expiresOn ?? null,
        };
        const words = stepWords(facts, { closing, priceCents });
        return {
          ...facts,
          label: label(step),
          note: s?.note ?? null,
          proof:
            s?.proofKind && s.proofId
              ? { kind: s.proofKind, id: s.proofId, label: proofs.get(s.id) ?? 'Proof' }
              : null,
          doneBy: s?.doneBy
            ? { id: s.doneBy, fullName: names.get(s.doneBy) ?? 'Former member' }
            : null,
          line: words.line,
          warning: words.warning,
        };
      }),
    };
  },
});

export const financingCommands = [
  financingSetLender,
  financingUpdateStep,
  financingMarkDone,
  financingReopen,
] as const;
export const financingQueries = [financingGet] as const;
