/**
 * Inspections and repairs, step 11 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core").
 *
 * - **An inspection** is planned with its inspector and time, and its report comes in as one of the deal's
 *   documents. The first report on a deal is the moment "the inspection report is in", which brings its duties.
 * - **Findings** say what was found, where, how serious and what it would cost; the client's priority (must fix,
 *   would like, skip) and what to ask for (repair, replace, a credit) are kept with each.
 * - **The repair request** is drafted from the findings (pure `repairDraft`), edited by the agent and kept as sent;
 *   each answer of the seller's is kept too. Agreed, it's the moment "repairs are agreed", with its duties.
 * - **On a listing** (round three, step 9) it's the other way round: the buyer's inspector comes to the home (S-52's
 *   appointment), the buyers' request comes in (`realestate.repair.receive`, the moment "a repair request was made",
 *   S-53's proof), and our seller's answer goes out (S-54's), agreed bringing S-55.
 */
import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm';
import { fmtAt } from '../../../calendar/when';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { findingFacts, INSPECTION_KINDS, repairDraft, type InspectionKind } from '../closing';
import type { DealEvent } from '../catalog/types';
import { realestateAddon } from '../manifest';
import {
  FindingAddInput,
  FindingAddOutput,
  FindingChangeOutput,
  FindingRemoveInput,
  FindingUpdateInput,
  InspectionAddInput,
  InspectionAddOutput,
  InspectionCancelInput,
  InspectionChangeOutput,
  InspectionReportInInput,
  InspectionsInput,
  InspectionsOutput,
  InspectionUpdateInput,
  RepairAnswerInput,
  RepairChangeOutput,
  RepairReceiveInput,
  RepairSendInput,
} from '../schemas';
import { documents, inspectionFindings, inspections, repairRequests } from '../tables';
import { termsNow } from '../terms';
import {
  actorUserId,
  historyLine,
  idUnavailable,
  inWorkspace,
  loadDeal,
  requireDealFiles,
  requireNotArchived,
  requireOpen,
  timeZoneOf,
  todayIn,
  withPhoneId,
  type Ctx,
  type Deal,
} from './common';
import { dealRecordEvent } from './deals';
import { termEntriesOf } from './engine';
import { requireListingSide } from './listing';
import { addProof, documentProof, PROOF_EVENTS } from './proof-hooks';

type Inspection = typeof inspections.$inferSelect;
type Finding = typeof inspectionFindings.$inferSelect;

const kindLabel = (k: string) => INSPECTION_KINDS[k as InspectionKind] ?? k;

async function loadInspection(ctx: Ctx, id: string, lock = false): Promise<Inspection> {
  const q = ctx.tx
    .select()
    .from(inspections)
    .where(and(eq(inspections.id, id), eq(inspections.workspaceId, ctx.scope.workspaceId!)));
  const [i] = lock ? await q.for('update') : await q;
  if (!i)
    throw HfosError.notFound(
      'That inspection isn’t there anymore, or you’re not on its deal. Refresh the deal’s inspections.',
    );
  return i;
}

async function loadFinding(ctx: Ctx, id: string): Promise<Finding> {
  const [f] = await ctx.tx
    .select()
    .from(inspectionFindings)
    .where(
      and(
        eq(inspectionFindings.id, id),
        eq(inspectionFindings.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!f)
    throw HfosError.notFound('That finding isn’t there anymore. Refresh the deal’s inspections.');
  return f;
}

/** A document on the deal: a repair request or the signed answer. */
async function requireDealDocument(ctx: Ctx, deal: Deal, documentId: string): Promise<void> {
  const [doc] = await ctx.tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.dealRecordId, deal.recordId)));
  if (!doc)
    throw HfosError.notFound(
      `That document isn’t on ${deal.name}. Upload it to the deal’s documents first, then pick it.`,
    );
}

function requireNotCanceled(i: Inspection): void {
  if (i.status === 'canceled')
    throw HfosError.rule(
      'realestate_inspection_canceled',
      409,
      `The ${kindLabel(i.kind).toLowerCase()} was canceled. Add a new inspection instead.`,
    );
}

/** A moment on the deal, when its side has duties for it; nothing when it doesn't. */
async function moment(
  ctx: CommandContext,
  deal: Deal,
  event: DealEvent,
  note: string,
): Promise<number> {
  try {
    const r = await executeCommandWithin(ctx, dealRecordEvent, {
      workspaceId: deal.workspaceId,
      dealId: deal.recordId,
      event,
      note,
    });
    return r.output.dutiesCreated;
  } catch (e) {
    if (e instanceof HfosError && e.rule === 'realestate_event_not_here') return 0;
    throw e;
  }
}

async function liveFindings(ctx: Ctx, dealId: string): Promise<Finding[]> {
  const list = await ctx.tx
    .select({ f: inspectionFindings, status: inspections.status })
    .from(inspectionFindings)
    .innerJoin(inspections, eq(inspections.id, inspectionFindings.inspectionId))
    .where(eq(inspectionFindings.dealRecordId, dealId))
    .orderBy(asc(inspections.createdAt), asc(inspectionFindings.position));
  return list.filter((x) => x.status !== 'canceled').map((x) => x.f);
}

/**
 * B-19 "Schedule inspections" (and B-22 for a specialist's): an inspection on the calendar is its appointment. On a
 * listing, it's S-52 "Coordinate buyer inspection access".
 */
async function inspectionProof(
  ctx: CommandContext,
  deal: Deal,
  kind: string,
  at: string,
  inspector: string | null | undefined,
): Promise<void> {
  const when = fmtAt(at, await timeZoneOf(ctx));
  await addProof(
    ctx,
    deal,
    {
      keys: deal.side === 'listing' ? ['S-52'] : kind === 'general' ? ['B-19'] : ['B-19', 'B-22'],
    },
    {
      kind: 'appointment',
      body: `${kindLabel(kind)} on ${when}${inspector ? ` with ${inspector}` : ''}`,
    },
  );
}

// ---------- inspections ----------

export const inspectionAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.inspection.add',
  description:
    'Add an inspection on a deal: its kind, the inspector, when, and when the report is expected. On a listing, it’s the buyer’s inspection at the home.',
  risk: 1,
  input: InspectionAddInput,
  output: InspectionAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_inspection',
    description:
      'Add an inspection to a deal, with the inspector and when (on a listing, the buyer’s inspection at the home).',
  },
  // At the inspection, with no signal: the phone's id, so its findings can wait beside it (board 85).
  offline: 'anytime',
  emits: ['realestate.inspection.changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    // Sent again after its answer was lost: the inspection it added.
    if (input.id) {
      const [had] = await ctx.tx
        .select({ id: inspections.id, dealRecordId: inspections.dealRecordId })
        .from(inspections)
        .where(
          and(eq(inspections.id, input.id), eq(inspections.workspaceId, ctx.scope.workspaceId!)),
        );
      if (had) {
        if (had.dealRecordId !== input.dealId) throw idUnavailable();
        return { inspectionId: had.id };
      }
    }
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const [row] = await withPhoneId('inspections', () =>
      ctx.tx
        .insert(inspections)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          kind: input.kind,
          inspector: input.inspector ?? null,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          reportExpectedOn: input.reportExpectedOn ?? null,
          note: input.note ?? null,
          createdBy: actorUserId(ctx),
        })
        .returning({ id: inspections.id }),
    );
    await historyLine(ctx, deal, 'inspection_added', { after: { kind: input.kind } });
    if (input.scheduledAt)
      await inspectionProof(ctx, deal, input.kind, input.scheduledAt, input.inspector);
    await ctx.emit({
      type: 'realestate.inspection.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: row!.id, what: 'added' },
    });
    return { inspectionId: row!.id };
  },
});

export const inspectionUpdate = defineAddonCommand(realestateAddon, {
  name: 'realestate.inspection.update',
  description: 'Change an inspection’s inspector, time, expected report date or note.',
  risk: 1,
  input: InspectionUpdateInput,
  output: InspectionChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_inspection_update', autonomy: 'confirm' },
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.inspection.changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const i = await loadInspection(ctx, input.inspectionId, true);
    const deal = await loadDeal(ctx, i.dealRecordId);
    requireNotArchived(deal);
    requireNotCanceled(i);
    if (input.scheduledAt && !i.scheduledAt)
      await inspectionProof(ctx, deal, i.kind, input.scheduledAt, input.inspector ?? i.inspector);
    await ctx.tx
      .update(inspections)
      .set({
        ...(input.inspector !== undefined ? { inspector: input.inspector } : {}),
        ...(input.scheduledAt !== undefined
          ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null }
          : {}),
        ...(input.reportExpectedOn !== undefined
          ? { reportExpectedOn: input.reportExpectedOn }
          : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        updatedAt: new Date(),
      })
      .where(eq(inspections.id, i.id));
    await ctx.emit({
      type: 'realestate.inspection.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: i.id, what: 'changed' },
    });
    return { inspectionId: i.id, status: i.status };
  },
});

export const inspectionReportIn = defineAddonCommand(realestateAddon, {
  name: 'realestate.inspection.report_in',
  description:
    'Mark an inspection’s report in, with the uploaded report. The deal’s first report brings the duties that follow one.',
  risk: 1,
  input: InspectionReportInInput,
  output: InspectionChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_inspection_report_in', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.inspection.report_in', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const i = await loadInspection(ctx, input.inspectionId, true);
    const deal = await loadDeal(ctx, i.dealRecordId, { lock: true });
    requireOpen(deal);
    requireNotCanceled(i);
    if (input.documentId) {
      const [doc] = await ctx.tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.dealRecordId, deal.recordId)));
      if (!doc)
        throw HfosError.notFound(
          `That document isn’t on ${deal.name}. Upload the report to the deal’s documents, then pick it.`,
        );
    }
    const first =
      (
        await ctx.tx
          .select({ id: inspections.id })
          .from(inspections)
          .where(
            and(eq(inspections.dealRecordId, deal.recordId), eq(inspections.status, 'report_in')),
          )
      ).length === 0;
    await ctx.tx
      .update(inspections)
      .set({
        status: 'report_in',
        reportInOn: input.reportInOn ?? i.reportInOn ?? todayIn(await timeZoneOf(ctx)),
        ...(input.documentId ? { reportDocumentId: input.documentId } : {}),
        ...(input.pages ? { pages: input.pages } : {}),
        updatedAt: new Date(),
      })
      .where(eq(inspections.id, i.id));
    await historyLine(ctx, deal, 'inspection_report_in', { after: { kind: i.kind } });
    if (first && i.status !== 'report_in')
      await moment(ctx, deal, 'inspection_report', `${kindLabel(i.kind)} report is in.`);
    // B-21 "Interpret inspection report": the report, once its duties are there.
    if (input.documentId) await documentProof(ctx, deal, input.documentId);
    await ctx.emit({
      type: 'realestate.inspection.report_in',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: i.id, documentId: input.documentId ?? i.reportDocumentId },
    });
    return { inspectionId: i.id, status: 'report_in' as const };
  },
});

export const inspectionCancel = defineAddonCommand(realestateAddon, {
  name: 'realestate.inspection.cancel',
  description:
    'Cancel an inspection, with the reason. Its findings stay, but no longer count toward the request.',
  risk: 1,
  input: InspectionCancelInput,
  output: InspectionChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_inspection_cancel', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.inspection.changed'],
  async handler(ctx, input) {
    const i = await loadInspection(ctx, input.inspectionId, true);
    const deal = await loadDeal(ctx, i.dealRecordId);
    requireNotArchived(deal);
    if (i.status === 'canceled') return { inspectionId: i.id, status: i.status };
    await ctx.tx
      .update(inspections)
      .set({ status: 'canceled', reportInOn: null, updatedAt: new Date() })
      .where(eq(inspections.id, i.id));
    await historyLine(ctx, deal, 'inspection_canceled', {
      after: { kind: i.kind },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.inspection.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: i.id, what: 'canceled' },
    });
    return { inspectionId: i.id, status: 'canceled' as const };
  },
});

// ---------- findings ----------

export const findingAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.finding.add',
  description:
    'Add what an inspection found: what and where, how serious, the estimate, the client’s priority, what to ask for and its photos.',
  risk: 1,
  input: FindingAddInput,
  output: FindingAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_finding',
    description:
      'Add a finding from an inspection report to the deal, with where it is and how serious.',
  },
  // Taken at the inspection, often in a basement or attic: works with no signal, with the phone's id (board 85).
  offline: 'anytime',
  emits: ['realestate.inspection.changed'],
  async handler(ctx, input) {
    const i = await loadInspection(ctx, input.inspectionId, true);
    // Sent again after its answer was lost: the finding it added.
    if (input.id) {
      const [had] = await ctx.tx
        .select({ id: inspectionFindings.id, inspectionId: inspectionFindings.inspectionId })
        .from(inspectionFindings)
        .where(
          and(
            eq(inspectionFindings.id, input.id),
            eq(inspectionFindings.workspaceId, i.workspaceId),
          ),
        );
      if (had) {
        if (had.inspectionId !== i.id) throw idUnavailable();
        return { findingId: had.id };
      }
    }
    const deal = await loadDeal(ctx, i.dealRecordId);
    requireNotArchived(deal);
    requireNotCanceled(i);
    // Its photos, uploaded from the phone before it.
    if (input.photoFileIds) await requireDealFiles(ctx, deal, input.photoFileIds, 'photo');
    const [last] = await ctx.tx
      .select({ n: max(inspectionFindings.position) })
      .from(inspectionFindings)
      .where(eq(inspectionFindings.inspectionId, i.id));
    const [row] = await withPhoneId('inspection_findings', () =>
      ctx.tx
        .insert(inspectionFindings)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: i.workspaceId,
          dealRecordId: i.dealRecordId,
          inspectionId: i.id,
          title: input.title,
          location: input.location ?? null,
          severity: input.severity,
          estimateCents: input.estimateCents ?? null,
          clientPriority: input.clientPriority ?? null,
          ask: input.ask ?? 'not_asked',
          creditCents: input.creditCents ?? null,
          position: (last?.n ?? 0) + 1,
          note: input.note ?? null,
          photoFileIds: [...new Set(input.photoFileIds ?? [])],
          createdBy: actorUserId(ctx),
        })
        .returning({ id: inspectionFindings.id }),
    );
    await ctx.emit({
      type: 'realestate.inspection.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: i.id, what: 'finding_added', findingId: row!.id },
    });
    return { findingId: row!.id };
  },
});

export const findingUpdate = defineAddonCommand(realestateAddon, {
  name: 'realestate.finding.update',
  description:
    'Change a finding: its words, how serious, the estimate, the client’s priority, what to ask for or its photos.',
  risk: 1,
  input: FindingUpdateInput,
  output: FindingChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_finding_update' },
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.inspection.changed'],
  async handler(ctx, input) {
    const f = await loadFinding(ctx, input.findingId);
    const deal = await loadDeal(ctx, f.dealRecordId);
    requireNotArchived(deal);
    if (input.photoFileIds) await requireDealFiles(ctx, deal, input.photoFileIds, 'photo');
    await ctx.tx
      .update(inspectionFindings)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}),
        ...(input.clientPriority !== undefined ? { clientPriority: input.clientPriority } : {}),
        ...(input.ask !== undefined ? { ask: input.ask } : {}),
        ...(input.creditCents !== undefined ? { creditCents: input.creditCents } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.photoFileIds ? { photoFileIds: [...new Set(input.photoFileIds)] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(inspectionFindings.id, f.id));
    await ctx.emit({
      type: 'realestate.inspection.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: f.inspectionId, what: 'finding_changed', findingId: f.id },
    });
    return { findingId: f.id };
  },
});

export const findingRemove = defineAddonCommand(realestateAddon, {
  name: 'realestate.finding.remove',
  description: 'Take off a finding typed in by mistake.',
  risk: 1,
  input: FindingRemoveInput,
  output: FindingChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_finding_remove', autonomy: 'confirm' },
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.inspection.changed'],
  async handler(ctx, input) {
    const f = await loadFinding(ctx, input.findingId);
    const deal = await loadDeal(ctx, f.dealRecordId);
    requireNotArchived(deal);
    await ctx.tx.delete(inspectionFindings).where(eq(inspectionFindings.id, f.id));
    await ctx.emit({
      type: 'realestate.inspection.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { inspectionId: f.inspectionId, what: 'finding_removed', findingId: f.id },
    });
    return { findingId: f.id };
  },
});

// ---------- the repair request ----------

async function nextRepairNumber(ctx: Ctx, dealId: string): Promise<number> {
  const [last] = await ctx.tx
    .select({ n: max(repairRequests.number) })
    .from(repairRequests)
    .where(eq(repairRequests.dealRecordId, dealId));
  return (last?.n ?? 0) + 1;
}

export const repairSend = defineAddonCommand(realestateAddon, {
  name: 'realestate.repair.send',
  description:
    'Keep the repair request as it was sent to the seller: its words, what it asks for by finding, and when they must answer by.',
  risk: 2,
  input: RepairSendInput,
  output: RepairChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_repair_send' },
  scope: inWorkspace,
  emits: ['realestate.repair.sent', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    if (deal.side === 'listing')
      throw HfosError.rule(
        'realestate_repair_listing',
        409,
        `On ${deal.name} the buyers ask for repairs and your seller answers. Keep their request as it came in, then your seller’s answer.`,
      );
    const all = await liveFindings(ctx, deal.recordId);
    const chosen = input.findingIds ? all.filter((f) => input.findingIds!.includes(f.id)) : all;
    if (input.findingIds && chosen.length !== new Set(input.findingIds).size)
      throw HfosError.notFound(
        'One of those findings isn’t on the deal anymore. Refresh the deal’s inspections.',
      );
    const draft = repairDraft(
      chosen.map((f) =>
        input.findingIds && f.ask === 'not_asked'
          ? { ...findingFacts(f), ask: 'repair' }
          : findingFacts(f),
      ),
    );
    const number = await nextRepairNumber(ctx, deal.recordId);
    const [row] = await ctx.tx
      .insert(repairRequests)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        number,
        side: 'us',
        at: input.at ? new Date(input.at) : changeMoment(ctx.meta),
        words: input.words,
        items: draft.items,
        creditCents: draft.creditCents,
        respondBy: input.respondBy ? new Date(input.respondBy) : null,
        note: input.note ?? null,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: repairRequests.id });
    await historyLine(ctx, deal, 'repair_requested', {
      after: { number, items: draft.items.length },
    });
    // B-24 "Develop repair strategy": the request is its note; B-25 "Negotiate inspection issues" is linked to it.
    await addProof(ctx, deal, { keys: ['B-24'] }, { kind: 'note', body: input.words });
    await addProof(
      ctx,
      deal,
      { keys: ['B-25'] },
      {
        kind: 'record',
        refKind: 'repair_request',
        refId: row!.id,
        body: `Repair request ${number} sent`,
      },
    );
    await ctx.emit({
      type: 'realestate.repair.sent',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { repairId: row!.id, number, respondBy: input.respondBy ?? null },
    });
    return { dealId: deal.recordId, repairId: row!.id, number, dutiesCreated: 0 };
  },
});

export const repairAnswer = defineAddonCommand(realestateAddon, {
  name: 'realestate.repair.record_answer',
  description:
    'Keep the seller’s answer to the repair request: agreed, a counter, or refused, in their words. Agreed brings the duties that follow agreed repairs.',
  risk: 2,
  input: RepairAnswerInput,
  output: RepairChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_repair_record_answer' },
  scope: inWorkspace,
  emits: ['realestate.repair.answered', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const listing = deal.side === 'listing';
    // The request is ours on a buyer deal, the buyers' on a listing; the answer is the other side's.
    const [asked] = await ctx.tx
      .select({ id: repairRequests.id })
      .from(repairRequests)
      .where(
        and(
          eq(repairRequests.dealRecordId, deal.recordId),
          eq(repairRequests.side, listing ? 'them' : 'us'),
          isNull(repairRequests.outcome),
        ),
      )
      .limit(1);
    if (!asked)
      throw HfosError.rule(
        'realestate_no_repair_request',
        409,
        listing
          ? `There’s no repair request on ${deal.name} yet. Keep the buyers’ request as it came in first, then your seller’s answer.`
          : `There’s no repair request on ${deal.name} yet. Keep the request you sent first, then the seller’s answer.`,
      );
    if (input.documentId) await requireDealDocument(ctx, deal, input.documentId);
    const number = await nextRepairNumber(ctx, deal.recordId);
    const [row] = await ctx.tx
      .insert(repairRequests)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        number,
        side: listing ? 'us' : 'them',
        at: input.at ? new Date(input.at) : changeMoment(ctx.meta),
        words: input.words,
        creditCents: input.creditCents ?? 0,
        respondBy: input.respondBy ? new Date(input.respondBy) : null,
        outcome: input.outcome,
        note: input.note ?? null,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: repairRequests.id });
    await historyLine(ctx, deal, 'repair_answered', { after: { number, outcome: input.outcome } });
    // On a listing, S-54 "Develop seller repair response": the answer, and its signed document.
    if (listing)
      await addProof(
        ctx,
        deal,
        { keys: ['S-54'] },
        { kind: 'note', body: `Our answer: ${input.words}` },
      );
    if (input.documentId) await documentProof(ctx, deal, input.documentId);
    await addProof(
      ctx,
      deal,
      { keys: ['B-25'] },
      {
        kind: 'record',
        refKind: 'repair_request',
        refId: row!.id,
        body: `The seller ${input.outcome === 'agreed' ? 'agreed' : input.outcome === 'countered' ? 'countered' : 'refused'}: ${input.words}`,
      },
    );
    const dutiesCreated =
      input.outcome === 'agreed'
        ? await moment(ctx, deal, 'repairs_agreed', 'The seller agreed to the repairs.')
        : 0;
    await ctx.emit({
      type: 'realestate.repair.answered',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { repairId: row!.id, number, outcome: input.outcome },
    });
    return { dealId: deal.recordId, repairId: row!.id, number, dutiesCreated };
  },
});

export const repairReceive = defineAddonCommand(realestateAddon, {
  name: 'realestate.repair.receive',
  description:
    'On a listing, keep the buyers’ repair request as it came in: its words, any credit asked for, and when it must be answered by. It brings the duties for answering it.',
  risk: 1,
  input: RepairReceiveInput,
  output: RepairChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_receive_repair_request',
    description: 'Keep the buyers’ repair request on a listing, as it came in.',
  },
  emits: ['realestate.repair.received', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireListingSide(deal);
    if (input.documentId) await requireDealDocument(ctx, deal, input.documentId);
    const number = await nextRepairNumber(ctx, deal.recordId);
    const [row] = await ctx.tx
      .insert(repairRequests)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        number,
        side: 'them',
        at: input.at ? new Date(input.at) : changeMoment(ctx.meta),
        words: input.words,
        creditCents: input.creditCents ?? 0,
        respondBy: input.respondBy ? new Date(input.respondBy) : null,
        note: input.note ?? null,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: repairRequests.id });
    await historyLine(ctx, deal, 'repair_received', { after: { number } });
    // S-53 to S-56 open with the first; a later one (after a counter) adds to them.
    const dutiesCreated = await moment(
      ctx,
      deal,
      'repair_request',
      'The buyers’ repair request came in.',
    );
    // S-53 "Review inspection request": the request is its note, and its document when there is one.
    await addProof(ctx, deal, { keys: ['S-53'] }, { kind: 'note', body: input.words });
    if (input.documentId) await documentProof(ctx, deal, input.documentId);
    await ctx.emit({
      type: 'realestate.repair.received',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { repairId: row!.id, number, respondBy: input.respondBy ?? null },
    });
    return { dealId: deal.recordId, repairId: row!.id, number, dutiesCreated };
  },
});

// ---------- the query ----------

export const inspectionsList = defineAddonQuery(realestateAddon, {
  name: 'realestate.inspections',
  description:
    'A buyer deal’s inspections and what each found, the repair request and the seller’s answers, the request the findings would draft now, and when the inspection period ends.',
  input: InspectionsInput,
  output: InspectionsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_inspections',
    description: 'A buyer deal’s inspections, their findings and the repair request.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(inspections)
      .where(eq(inspections.dealRecordId, deal.recordId))
      .orderBy(asc(inspections.createdAt), asc(inspections.id));
    const findings = list.length
      ? await ctx.tx
          .select()
          .from(inspectionFindings)
          .where(
            inArray(
              inspectionFindings.inspectionId,
              list.map((i) => i.id),
            ),
          )
          .orderBy(asc(inspectionFindings.position), asc(inspectionFindings.id))
      : [];
    const reportIds = list.map((i) => i.reportDocumentId).filter((x): x is string => !!x);
    const reports = reportIds.length
      ? await ctx.tx
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(inArray(documents.id, reportIds))
      : [];
    const repairs = await ctx.tx
      .select()
      .from(repairRequests)
      .where(eq(repairRequests.dealRecordId, deal.recordId))
      .orderBy(asc(repairRequests.number), asc(repairRequests.id));
    const terms = termsNow(await termEntriesOf(ctx, deal.recordId));
    const live = findings.filter(
      (f) => list.find((i) => i.id === f.inspectionId)?.status !== 'canceled',
    );
    const draft = repairDraft(live.map(findingFacts));
    return {
      periodEnds: terms.get('inspection_end')?.current?.valueDate ?? null,
      inspections: list.map((i) => {
        const report = reports.find((r) => r.id === i.reportDocumentId);
        return {
          id: i.id,
          kind: i.kind as InspectionKind,
          label: kindLabel(i.kind),
          inspector: i.inspector,
          scheduledAt: i.scheduledAt?.toISOString() ?? null,
          reportExpectedOn: i.reportExpectedOn,
          status: i.status,
          reportDocument: report ? { id: report.id, title: report.title } : null,
          reportInOn: i.reportInOn,
          pages: i.pages,
          note: i.note,
          findings: findings
            .filter((f) => f.inspectionId === i.id)
            .map((f) => ({
              id: f.id,
              title: f.title,
              location: f.location,
              severity: f.severity,
              estimateCents: f.estimateCents,
              clientPriority: f.clientPriority,
              ask: f.ask,
              creditCents: f.creditCents,
              note: f.note,
              photoFileIds: f.photoFileIds,
            })),
        };
      }),
      repairs: repairs.map((r) => ({
        id: r.id,
        number: r.number,
        side: r.side,
        at: r.at.toISOString(),
        words: r.words,
        creditCents: r.creditCents,
        respondBy: r.respondBy?.toISOString() ?? null,
        outcome: r.outcome,
        items: r.items,
      })),
      draft: { words: draft.words, creditCents: draft.creditCents, items: draft.items.length },
    };
  },
});

export const inspectionCommands = [
  inspectionAdd,
  inspectionUpdate,
  inspectionReportIn,
  inspectionCancel,
  findingAdd,
  findingUpdate,
  findingRemove,
  repairSend,
  repairAnswer,
  repairReceive,
] as const;
export const inspectionQueries = [inspectionsList] as const;
