/**
 * Working a duty (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties"; spec §11, §22): its status, the proof
 * added to it, who answers for it, its due time set by hand, and finishing it. Completing one asks for the proof its
 * rule names and refuses with `duty_needs_proof`, saying what's missing; owners and admins may complete one without
 * it, or waive it, with a reason (`realestate.except`). Being blocked never moves a due date. Every change is a line
 * in `duty_log`, and the kernel's event and audit rows say whether a person, HandsFreeOS or the AI did it.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { appointments, files, messages } from '@hfos/db/schema';
import { localInstant } from '../../../calendar/engine/zoned';
import { addonAlertAcknowledge } from '../../../commands/addon-alert';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import type { DealField, ProofRule, ResolvedDuty } from '../catalog/types';
import { dayOff } from '../dates/business-days';
import { END_OF_DAY } from '../dates/due';
import { realestateAddon } from '../manifest';
import { ownDuty, WIRE_CHECK_KEY, wireCheck } from '../own-duties';
import { gapWords, proofGaps, type DealProofFacts, type EvidenceFact } from '../proof';
import {
  DealReportWireChangeInput,
  DealReportWireChangeOutput,
  DutyAcknowledgeInput,
  DutyAddEvidenceInput,
  DutyAddInput,
  DutyAssignInput,
  DutyCompleteInput,
  DutyEvidenceOutput,
  DutyOutput,
  DutyReasonInput,
  DutySetDueInput,
  DutySetStatusInput,
  DutyWithdrawEvidenceInput,
} from '../schemas';
import { canMoveDuty, DUTY_STATUS_LABELS, isDoneDuty, type DutyStatus } from '../states';
import { documents, duties, dutyEvidence, dutyLog } from '../tables';
import { keyDatesOf, termsNow } from '../terms';
import {
  actorKind,
  actorUserId,
  dealLine,
  historyLine,
  idUnavailable,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  timeZoneOf,
  userNames,
  withPhoneId,
  type Ctx,
  type Deal,
} from './common';
import { openWork, termEntriesOf } from './engine';
import { propertyOf } from './people';
import { chaseDefault, chaseOn } from './chase';

export type DutyRow = typeof duties.$inferSelect;

const dutyGone = () =>
  HfosError.notFound(
    'That duty isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s duties.',
  );

/** A duty on a deal the person sees, and its deal. */
export async function loadDuty(
  ctx: Ctx,
  dutyId: string,
  opts: { readonly lock?: boolean } = {},
): Promise<{ duty: DutyRow; deal: Deal }> {
  const q = ctx.tx
    .select()
    .from(duties)
    .where(and(eq(duties.id, dutyId), eq(duties.workspaceId, ctx.scope.workspaceId!)));
  const [duty] = opts.lock ? await q.for('update') : await q;
  if (!duty) throw dutyGone();
  return { duty, deal: await loadDeal(ctx, duty.dealRecordId) };
}

const definitionOf = (d: DutyRow) => d.definition as unknown as ResolvedDuty;

/** A line in the duty's own history. */
export async function logLine(
  ctx: CommandContext,
  d: DutyRow,
  what: string,
  change: { before?: object | null; after?: object | null; note?: string | null } = {},
) {
  await ctx.tx.insert(dutyLog).values({
    workspaceId: d.workspaceId,
    dealRecordId: d.dealRecordId,
    dutyId: d.id,
    at: changeMoment(ctx.meta),
    actorType: actorKind(ctx),
    actorUserId: actorUserId(ctx),
    what,
    before: (change.before ?? null) as Record<string, unknown> | null,
    after: (change.after ?? null) as Record<string, unknown> | null,
    note: change.note ?? null,
  });
}

const finished = (d: DutyRow) =>
  HfosError.rule(
    'realestate_duty_finished',
    409,
    `“${d.title}” is ${DUTY_STATUS_LABELS[d.status as DutyStatus].toLowerCase()}. Reopen it first to change it.`,
  );

/** The proof on a duty, as the check reads it. */
export async function evidenceFactsOf(ctx: Ctx, dutyId: string): Promise<EvidenceFact[]> {
  const list = await rows<{
    kind: EvidenceFact['kind'];
    withdrawn: boolean;
    document_kind: string | null;
    signed: boolean | null;
  }>(
    ctx.tx,
    sql`select e.kind, e.withdrawn_at is not null as withdrawn, d.kind as document_kind,
          d.signed_at is not null and d.status <> 'void' as signed
        from addon_realestate.duty_evidence e
        left join addon_realestate.documents d on d.id = e.document_id
        where e.duty_id = ${dutyId}`,
  );
  return list.map((e) => ({
    kind: e.kind,
    withdrawn: e.withdrawn,
    documentKind: e.document_kind,
    signed: e.signed === true,
  }));
}

/** What the deal holds that a rule may ask for: its confirmed dates and its filled-in values. */
export async function dealProofFactsOf(ctx: Ctx, deal: Deal): Promise<DealProofFacts> {
  const keyDates = keyDatesOf(termsNow(await termEntriesOf(ctx, deal.recordId)));
  const [client] = await rows<{ id: string }>(
    ctx.tx,
    sql`select rel.id from app.relationships rel
        join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
        where rel.b_custom_record_id = ${deal.recordId} limit 1`,
  );
  const fields = new Set<DealField>();
  if (deal.expectedCommissionCents !== null) fields.add('expected_commission');
  if (deal.finalCommissionCents !== null) fields.add('final_commission');
  if (await propertyOf(ctx, deal.recordId)) fields.add('property');
  if (client) fields.add('client');
  return {
    confirmedDates: new Set(
      (Object.keys(keyDates) as (keyof typeof keyDates)[]).filter((k) => keyDates[k]?.confirmed),
    ),
    fields,
  };
}

/** What's missing before a duty can be marked done, in words; empty when nothing is. */
export async function missingProof(ctx: Ctx, duty: DutyRow, deal: Deal): Promise<string> {
  const rule = definitionOf(duty).proof as ProofRule | null;
  const gaps = proofGaps(
    rule,
    await evidenceFactsOf(ctx, duty.id),
    await dealProofFactsOf(ctx, deal),
  );
  return gaps.length ? gapWords(rule, gaps) : '';
}

/** The deal's due times, drafts and health again, after a duty changed. */
async function settleDeal(ctx: CommandContext, deal: Deal) {
  const w = await openWork(ctx, deal);
  await w.settle();
}

const answer = (d: DutyRow, status: DutyStatus = d.status as DutyStatus) => ({
  dealId: d.dealRecordId,
  dutyId: d.id,
  status,
});

export async function dutyEvent(
  ctx: CommandContext,
  type: string,
  d: DutyRow,
  deal: Deal,
  more: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    payload?: object;
  } = {},
) {
  return ctx.emit({
    type,
    entityType: 'custom_record',
    entityId: deal.recordId,
    payload: {
      name: deal.name,
      dutyId: d.id,
      dutyKey: d.dutyKey,
      title: d.title,
      ...(more.payload ?? {}),
    },
    before: more.before ? { duty: d.title, ...more.before } : null,
    after: { duty: d.title, ...(more.after ?? {}) },
  });
}

// ---------- status ----------

export const dutySetStatus = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.set_status',
  description:
    'Say where a duty stands: not started, in progress, waiting on someone (who), or blocked (by what, whose it is to clear, what it holds up, when to look again). Its due date never moves for it.',
  risk: 1,
  input: DutySetStatusInput,
  output: DutyOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_update_duty',
    description:
      'Say where a duty stands: in progress, waiting on someone, or blocked with what’s in the way. Asks the person first.',
    autonomy: 'confirm',
  },
  // Where it stands, said in the field: nothing reaches a client, and its due date never moves for it.
  offline: 'anytime',
  emits: ['realestate.duty.status_changed'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    const from = duty.status as DutyStatus;
    if (isDoneDuty(from)) throw finished(duty);
    const same =
      from === input.status &&
      (input.status !== 'waiting_external' ||
        (duty.waitingOn === input.waitingOn && !input.chaseOn)) &&
      input.status !== 'blocked';
    if (same) return answer(duty);
    if (from !== input.status && !canMoveDuty(from, input.status))
      throw HfosError.rule(
        'realestate_duty_move',
        409,
        from === 'draft'
          ? `“${duty.title}” is a draft until the dates it rests on are confirmed. Start it as not started first.`
          : `“${duty.title}” can’t go from ${DUTY_STATUS_LABELS[from].toLowerCase()} to ${DUTY_STATUS_LABELS[input.status].toLowerCase()}.`,
      );
    const at = changeMoment(ctx.meta);
    const blocked = input.status === 'blocked' ? input.blocker! : null;
    // Waiting on someone outside: since when, and the day to chase them (round four).
    const waiting = input.status === 'waiting_external';
    const chaseAt = !waiting
      ? null
      : input.chaseOn
        ? chaseOn(input.chaseOn, await timeZoneOf(ctx))
        : from === 'waiting_external' && duty.chaseAt
          ? duty.chaseAt
          : await chaseDefault(ctx, at);
    await ctx.tx
      .update(duties)
      .set({
        status: input.status,
        waitingSince: waiting ? (from === 'waiting_external' ? duty.waitingSince : at) : null,
        chaseAt,
        waitingOn: input.status === 'waiting_external' ? input.waitingOn! : null,
        blocker: blocked?.what ?? null,
        blockerOwner: blocked?.owner ?? null,
        blockerImpact: blocked?.impact ?? null,
        blockerReviewAt: blocked ? new Date(blocked.reviewAt) : null,
        updatedAt: at,
      })
      .where(eq(duties.id, duty.id));
    const after = {
      status: input.status,
      ...(input.waitingOn && input.status === 'waiting_external'
        ? { waitingOn: input.waitingOn }
        : {}),
      ...(blocked ? { blocker: blocked.what, owner: blocked.owner, impact: blocked.impact } : {}),
    };
    await logLine(ctx, duty, 'status', {
      before: { status: from },
      after,
      note: input.note ?? null,
    });
    await dutyEvent(ctx, 'realestate.duty.status_changed', duty, deal, {
      before: { status: DUTY_STATUS_LABELS[from] },
      after: { status: DUTY_STATUS_LABELS[input.status] },
      payload: { from, to: input.status },
    });
    await settleDeal(ctx, deal);
    return answer(duty, input.status);
  },
});

// ---------- proof ----------

export const dutyAddEvidence = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.add_evidence',
  description:
    'Add proof to a duty: one of the deal’s documents or files, a note, the person’s own word (an attestation), an appointment or a message. Answers what’s still missing.',
  risk: 1,
  input: DutyAddEvidenceInput,
  output: DutyEvidenceOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_proof',
    description:
      'Add proof to a duty: a note, or one of the deal’s documents or files. It never gives the person’s word for them. Asks the person first.',
    autonomy: 'confirm',
  },
  // A photo, a file or a note goes on with no signal, with the phone's id (board 79).
  offline: 'anytime',
  emits: ['realestate.duty.evidence_added'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    // Sent again after its answer was lost: the proof it added.
    if (input.id) {
      const [had] = await ctx.tx
        .select({ id: dutyEvidence.id, dutyId: dutyEvidence.dutyId })
        .from(dutyEvidence)
        .where(and(eq(dutyEvidence.id, input.id), eq(dutyEvidence.workspaceId, duty.workspaceId)));
      if (had) {
        if (had.dutyId !== duty.id) throw idUnavailable();
        return {
          dealId: deal.recordId,
          dutyId: duty.id,
          evidenceId: had.id,
          missing: await missingProof(ctx, duty, deal),
        };
      }
    }
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus)) throw finished(duty);
    // Only a person says, in their own name, that they did something (spec §22: it never claims to have attended).
    if (input.kind === 'attestation' && actorKind(ctx) !== 'person')
      throw HfosError.rule(
        'realestate_attest_in_person',
        403,
        'Only you can give your word on a duty, on the duty itself. The Assistant can’t say it for you.',
      );
    const ws = ctx.scope.workspaceId!;
    const notHere = (what: string) =>
      HfosError.notFound(`That ${what} isn’t on this deal. Pick one of the deal’s own.`);
    if (input.kind === 'document') {
      const [doc] = await ctx.tx
        .select({ id: documents.id, fileId: documents.fileId })
        .from(documents)
        .where(and(eq(documents.id, input.documentId!), eq(documents.dealRecordId, deal.recordId)));
      if (!doc) throw notHere('document');
    }
    if (input.kind === 'file') {
      const [f] = await ctx.tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.id, input.fileId!),
            eq(files.workspaceId, ws),
            eq(files.recordType, 'custom_record'),
            eq(files.recordId, deal.recordId),
            dsql`${files.deletedAt} is null`,
          ),
        );
      if (!f) throw notHere('file');
    }
    if (input.kind === 'appointment') {
      const [a] = await ctx.tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.id, input.appointmentId!), eq(appointments.workspaceId, ws)));
      if (!a) throw HfosError.notFound('That appointment isn’t there anymore. Pick another.');
    }
    if (input.kind === 'message') {
      const [m] = await ctx.tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, input.messageId!), eq(messages.workspaceId, ws)));
      if (!m) throw HfosError.notFound('That message isn’t there anymore. Pick another.');
    }
    const [row] = await withPhoneId('duty_evidence', () =>
      ctx.tx
        .insert(dutyEvidence)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: ws,
          dealRecordId: deal.recordId,
          dutyId: duty.id,
          kind: input.kind,
          documentId: input.kind === 'document' ? input.documentId! : null,
          fileId: input.kind === 'file' ? input.fileId! : null,
          appointmentId: input.kind === 'appointment' ? input.appointmentId! : null,
          messageId: input.kind === 'message' ? input.messageId! : null,
          body: input.body ?? null,
          addedBy: actorUserId(ctx),
          addedAt: changeMoment(ctx.meta),
        })
        .returning({ id: dutyEvidence.id }),
    );
    await logLine(ctx, duty, 'evidence_added', {
      after: { evidenceId: row!.id, kind: input.kind },
    });
    await dutyEvent(ctx, 'realestate.duty.evidence_added', duty, deal, {
      after: { proof: input.kind },
      payload: { evidenceId: row!.id, kind: input.kind },
    });
    return {
      dealId: deal.recordId,
      dutyId: duty.id,
      evidenceId: row!.id,
      missing: await missingProof(ctx, duty, deal),
    };
  },
});

export const dutyWithdrawEvidence = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.withdraw_evidence',
  description:
    'Take back proof added to a duty by mistake, with why. It stays in the duty’s history and no longer counts.',
  risk: 1,
  input: DutyWithdrawEvidenceInput,
  output: DutyEvidenceOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_withdraw_evidence', autonomy: 'confirm' },
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.duty.evidence_withdrawn'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus)) throw finished(duty);
    const [row] = await ctx.tx
      .update(dutyEvidence)
      .set({
        withdrawnAt: changeMoment(ctx.meta),
        withdrawnBy: actorUserId(ctx),
        withdrawnReason: input.reason,
      })
      .where(
        and(
          eq(dutyEvidence.id, input.evidenceId),
          eq(dutyEvidence.dutyId, duty.id),
          dsql`${dutyEvidence.withdrawnAt} is null`,
        ),
      )
      .returning({ id: dutyEvidence.id, kind: dutyEvidence.kind });
    if (!row)
      throw HfosError.notFound(
        'That proof isn’t on this duty anymore, or it was already taken back. Refresh to see its proof.',
      );
    await logLine(ctx, duty, 'evidence_withdrawn', {
      before: { evidenceId: row.id, kind: row.kind },
      note: input.reason,
    });
    await dutyEvent(ctx, 'realestate.duty.evidence_withdrawn', duty, deal, {
      before: { proof: row.kind },
      payload: { evidenceId: row.id, reason: input.reason },
    });
    return {
      dealId: deal.recordId,
      dutyId: duty.id,
      evidenceId: row.id,
      missing: await missingProof(ctx, duty, deal),
    };
  },
});

// ---------- who answers for it ----------

export const dutyAssign = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.assign',
  description:
    'Give a duty to someone on its deal to answer for, or to nobody by name (the brokerage). Only someone on the deal can have one.',
  risk: 1,
  input: DutyAssignInput,
  output: DutyOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_assign', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.assigned'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus)) throw finished(duty);
    if (duty.accountableUserId === input.userId) return answer(duty);
    const names = await userNames(ctx, [input.userId, duty.accountableUserId]);
    if (
      input.userId &&
      deal.ownerUserId !== input.userId &&
      !deal.teamUserIds.includes(input.userId)
    )
      throw HfosError.rule(
        'realestate_not_on_deal',
        409,
        `${names.get(input.userId) ?? 'That person'} isn’t on ${deal.name}. Put them on the deal first, then give them the duty.`,
      );
    await ctx.tx
      .update(duties)
      .set({ accountableUserId: input.userId, updatedAt: changeMoment(ctx.meta) })
      .where(eq(duties.id, duty.id));
    await logLine(ctx, duty, 'reassigned', {
      before: { accountableUserId: duty.accountableUserId },
      after: { accountableUserId: input.userId },
    });
    const who = (id: string | null) => (id ? (names.get(id) ?? 'Former member') : 'The brokerage');
    await dutyEvent(ctx, 'realestate.duty.assigned', duty, deal, {
      before: { accountable: who(duty.accountableUserId) },
      after: { accountable: who(input.userId) },
      payload: { userId: input.userId },
    });
    await settleDeal(ctx, deal);
    return answer(duty);
  },
});

export const dutyAcknowledge = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.acknowledge',
  description:
    'Say you’ve seen that a duty is at risk. The alert stops asking; the duty still needs doing.',
  risk: 0,
  input: DutyAcknowledgeInput,
  output: DutyOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_acknowledge' },
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.duty.acknowledged'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus) || duty.acknowledgedAt) return answer(duty);
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(duties)
      .set({ acknowledgedAt: at, acknowledgedBy: actorUserId(ctx), updatedAt: at })
      .where(eq(duties.id, duty.id));
    await logLine(ctx, duty, 'acknowledged');
    // Its card on Home asking the same goes quiet too.
    const [alert] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.addon_alerts
          where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'realestate'
            and key = ${`duty:${duty.id}`} and cleared_at is null and needs_ack
            and acknowledged_at is null`,
    );
    if (alert)
      await executeCommandWithin(ctx, addonAlertAcknowledge, {
        workspaceId: ctx.scope.workspaceId!,
        alertId: alert.id,
      });
    await dutyEvent(ctx, 'realestate.duty.acknowledged', duty, deal, {
      after: { acknowledged: true },
    });
    return answer(duty);
  },
});

// ---------- finishing ----------

async function finish(
  ctx: CommandContext,
  duty: DutyRow,
  deal: Deal,
  to: 'completed' | 'waived' | 'cancelled',
  opts: { readonly reason?: string | null; readonly exception?: boolean },
) {
  const at = changeMoment(ctx.meta);
  await ctx.tx
    .update(duties)
    .set({
      status: to,
      finishedAt: at,
      finishedBy: actorUserId(ctx),
      finishReason: opts.reason ?? null,
      exception: opts.exception === true,
      waitingOn: null,
      blocker: null,
      blockerOwner: null,
      blockerImpact: null,
      blockerReviewAt: null,
      updatedAt: at,
    })
    .where(eq(duties.id, duty.id));
  const what = opts.exception ? 'completed_with_exception' : to;
  await logLine(ctx, duty, what, {
    before: { status: duty.status },
    after: { status: to, ...(opts.exception ? { exception: true } : {}) },
    note: opts.reason ?? null,
  });
  const type =
    to === 'completed'
      ? 'realestate.duty.completed'
      : to === 'waived'
        ? 'realestate.duty.waived'
        : 'realestate.duty.cancelled';
  const eventId = await dutyEvent(ctx, type, duty, deal, {
    before: { status: DUTY_STATUS_LABELS[duty.status as DutyStatus] },
    after: { status: DUTY_STATUS_LABELS[to], ...(opts.exception ? { exception: true } : {}) },
    payload: { exception: opts.exception === true, reason: opts.reason ?? null },
  });
  const words =
    to === 'completed'
      ? opts.exception
        ? `marked “${duty.title}” done without its proof`
        : `marked “${duty.title}” done`
      : to === 'waived'
        ? `waived “${duty.title}”`
        : `cancelled “${duty.title}”`;
  await dealLine(ctx, deal, words, {
    eventId,
    body: opts.reason ?? null,
    tone: to === 'completed' && !opts.exception ? 'success' : 'warning',
  });
  await settleDeal(ctx, deal);
  return answer(duty, to);
}

/** A draft or one waiting for approval isn't ready to finish; a finished one is finished. */
function requireWorkable(duty: DutyRow) {
  const s = duty.status as DutyStatus;
  if (isDoneDuty(s)) throw finished(duty);
  if (s === 'draft' || s === 'pending_approval')
    throw HfosError.rule(
      'realestate_duty_move',
      409,
      `“${duty.title}” is ${DUTY_STATUS_LABELS[s].toLowerCase()}. Start it first, then mark it done.`,
    );
}

export const dutyComplete = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.complete',
  description:
    'Mark a duty done. Refused until it has the proof its rule asks for, saying what’s missing; an owner or admin can mark it done without it, with a reason.',
  risk: 1,
  input: DutyCompleteInput,
  output: DutyOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_complete_duty',
    description: 'Mark a duty done once it has its proof. Asks the person first.',
    autonomy: 'confirm',
  },
  // Done right away on the phone, marked as waiting; it counts when it arrives, with the time it was done there
  // (board 79). Done without its proof is an exception, and needs signal.
  offline: 'anytime',
  emits: ['realestate.duty.completed'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    // Already done (by someone else while this waited, or this change sent again): nothing more to do.
    if (duty.status === 'completed') return answer(duty);
    requireWorkable(duty);
    const missing = await missingProof(ctx, duty, deal);
    if (missing)
      throw HfosError.rule(
        'duty_needs_proof',
        409,
        `“${duty.title}” can be marked done once it has ${missing}. Add it under Proof on the duty. If it can’t be had, an owner or admin can mark it done without it.`,
      );
    return finish(ctx, duty, deal, 'completed', { reason: input.note ?? null });
  },
});

export const dutyCompleteWithException = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.complete_with_exception',
  description:
    'Mark a duty done without the proof its rule asks for, with the reason. Owners and admins (Approve exceptions) only; kept in its history.',
  risk: 2,
  input: DutyReasonInput,
  output: DutyOutput,
  permission: 'realestate.except',
  ai: { tool: 'realestate_duty_complete_with_exception', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.completed'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    requireWorkable(duty);
    const missing = await missingProof(ctx, duty, deal);
    return finish(ctx, duty, deal, 'completed', {
      reason: input.reason,
      // Only an exception when proof was missing; otherwise it's simply done.
      exception: missing !== '',
    });
  },
});

export const dutyWaive = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.waive',
  description:
    'Waive a duty that isn’t needed on this deal, with the reason. Owners and admins (Approve exceptions) only.',
  risk: 2,
  input: DutyReasonInput,
  output: DutyOutput,
  permission: 'realestate.except',
  ai: { tool: 'realestate_duty_waive', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.waived'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus)) throw finished(duty);
    return finish(ctx, duty, deal, 'waived', { reason: input.reason });
  },
});

export const dutyCancel = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.cancel',
  description:
    'Cancel a duty that no longer applies (a stage the deal skipped, a step that won’t happen), with the reason.',
  risk: 2,
  input: DutyReasonInput,
  output: DutyOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_cancel' },
  scope: inWorkspace,
  emits: ['realestate.duty.cancelled'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus)) throw finished(duty);
    return finish(ctx, duty, deal, 'cancelled', { reason: input.reason });
  },
});

export const dutyReopen = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.reopen',
  description:
    'Put a finished duty back to work, with why: a done one goes back in progress, a waived or cancelled one to not started.',
  risk: 1,
  input: DutyReasonInput,
  output: DutyOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_reopen', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.reopened'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    const from = duty.status as DutyStatus;
    if (!isDoneDuty(from)) return answer(duty);
    const to: DutyStatus = from === 'completed' ? 'in_progress' : 'not_started';
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(duties)
      .set({
        status: to,
        finishedAt: null,
        finishedBy: null,
        finishReason: null,
        exception: false,
        acknowledgedAt: null,
        acknowledgedBy: null,
        updatedAt: at,
      })
      .where(eq(duties.id, duty.id));
    await logLine(ctx, duty, 'reopened', {
      before: { status: from, exception: duty.exception },
      after: { status: to },
      note: input.reason,
    });
    const eventId = await dutyEvent(ctx, 'realestate.duty.reopened', duty, deal, {
      before: { status: DUTY_STATUS_LABELS[from] },
      after: { status: DUTY_STATUS_LABELS[to] },
      payload: { reason: input.reason },
    });
    await dealLine(ctx, deal, `reopened “${duty.title}”`, { eventId, body: input.reason });
    // Its due time may have moved while it was finished.
    const w = await openWork(ctx, deal);
    await w.settle();
    return answer(duty, to);
  },
});

// ---------- due by hand ----------

export const dutySetDue = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.set_due',
  description:
    'Set when a duty is due by hand, with why, or clear it so its rule decides again. A date with no time is due at 11:59 pm where the business is.',
  risk: 1,
  input: DutySetDueInput,
  output: DutyOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_set_due', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.due_set'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (isDoneDuty(duty.status as DutyStatus)) throw finished(duty);
    const w = await openWork(ctx, deal);
    const was = duty.dueAt?.toISOString() ?? null;
    if (input.clear) {
      if (!duty.dueOverrideAt) return answer(duty);
      await ctx.tx
        .update(duties)
        .set({ dueOverrideAt: null, dueOverrideReason: null, updatedAt: w.at })
        .where(eq(duties.id, duty.id));
      // Its rule decides again, from the dates as they are now (settled below).
    } else {
      const time = input.time ?? END_OF_DAY;
      const dueAt = new Date(localInstant(input.date!, time, w.timeZone));
      // A day off keeps its date, and says so, as a calendar-day rule's would.
      const off = dayOff(input.date!, w.calendar);
      await ctx.tx
        .update(duties)
        .set({
          dueState: 'due',
          dueAt,
          dueDate: input.date!,
          dueTime: time,
          dueTrace: [{ step: 'set_by_hand', date: input.date!, time }],
          dueWarnings: off ? [{ code: 'not_a_business_day', date: input.date!, off }] : [],
          needsDates: [],
          dueOverrideAt: w.at,
          dueOverrideReason: input.reason!,
          updatedAt: w.at,
        })
        .where(eq(duties.id, duty.id));
    }
    await settleDeal(ctx, deal);
    const [now] = await ctx.tx
      .select({ dueAt: duties.dueAt })
      .from(duties)
      .where(eq(duties.id, duty.id));
    const after = now?.dueAt?.toISOString() ?? null;
    await logLine(ctx, duty, 'due_set', {
      before: { dueAt: was },
      after: { dueAt: after, byHand: !input.clear },
      note: input.reason ?? null,
    });
    await dutyEvent(ctx, 'realestate.duty.due_set', duty, deal, {
      before: { dueAt: was },
      after: { dueAt: after },
      payload: { byHand: !input.clear, reason: input.reason ?? null },
    });
    return answer(duty);
  },
});

// ---------- a duty of the deal's own ----------

export const dutyAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.add',
  description:
    'Write a duty on one deal that its list doesn’t have: its name, who answers for it, how much it matters, what proof finishes it, and when it’s due.',
  risk: 1,
  input: DutyAddInput,
  output: DutyOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_duty',
    description: 'Write a duty on one deal. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.duty.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    if (
      input.accountableUserId &&
      deal.ownerUserId !== input.accountableUserId &&
      !deal.teamUserIds.includes(input.accountableUserId)
    )
      throw HfosError.rule(
        'realestate_not_on_deal',
        409,
        `Only someone on ${deal.name} can answer for its duties. Put them on the deal first.`,
      );
    // Its own duties are W-01 onwards; W-00 is the wire check.
    const [last] = await rows<{ n: number | null }>(
      ctx.tx,
      sql`select max(substring(duty_key from 3)::int) as n from addon_realestate.duties
          where deal_record_id = ${deal.recordId} and duty_key like 'W-%' and duty_key <> ${WIRE_CHECK_KEY}`,
    );
    const n = (last?.n ?? 0) + 1;
    const key = `W-${String(n).padStart(2, '0')}`;
    const def = ownDuty({
      key,
      side: deal.side,
      stage: deal.stage,
      title: input.title,
      details: input.details ?? null,
      tracker: input.tracker,
      accountable: 'agent',
      materiality: input.materiality,
      proof: input.proof,
      attestation: input.attestation ?? null,
    });
    const w = await openWork(ctx, deal);
    const time = input.dueTime ?? END_OF_DAY;
    const dutyId = await w.addDuty(def, {
      startedBy: 'manual:added',
      accountableUserId: input.accountableUserId ?? deal.ownerUserId,
      ...(input.dueDate
        ? {
            due: {
              at: new Date(localInstant(input.dueDate, time, w.timeZone)),
              date: input.dueDate,
              time,
              reason: 'Set when the duty was added',
            },
          }
        : {}),
    });
    await w.settle();
    await historyLine(ctx, deal, 'duty_added', { after: { dutyId, key, title: input.title } });
    const [row] = await ctx.tx.select().from(duties).where(eq(duties.id, dutyId));
    const eventId = await dutyEvent(ctx, 'realestate.duty.added', row!, deal, {
      after: { status: 'Not started' },
    });
    await dealLine(ctx, deal, `added a duty, “${input.title}”`, { eventId });
    return answer(row!);
  },
});

// ---------- a changed wire ----------

export const dealReportWireChange = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.report_wire_change',
  description:
    'Someone said a deal’s wiring instructions changed: a critical alert at once, and a hold that ends only when a person checks by phone at a number they found themselves. Nothing relays the new instructions.',
  risk: 1,
  input: DealReportWireChangeInput,
  output: DealReportWireChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_report_wire_change',
    description:
      'Report that a deal’s wiring instructions reportedly changed: holds every payment until a person checks by phone. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.deal.wire_change_reported'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const w = await openWork(ctx, deal);
    // One check at a time: a second report joins the one still open.
    const open = w.duties.find((d) => d.dutyKey === WIRE_CHECK_KEY && !isDoneDuty(d.status));
    const dutyId =
      open?.id ??
      (await w.addDuty(wireCheck(deal.side, deal.stage), { startedBy: 'manual:wire_change' }));
    await w.settle();
    await historyLine(ctx, deal, 'wire_change', {
      after: { dutyId, how: input.how, from: input.from ?? null },
      note: input.note ?? null,
    });
    const eventId = await ctx.emit({
      type: 'realestate.deal.wire_change_reported',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        dutyId,
        how: input.how,
        ownerUserId: deal.ownerUserId,
      },
      after: { name: deal.name, wireHold: true },
    });
    await dealLine(ctx, deal, 'reported that the wiring instructions changed', {
      eventId,
      tone: 'danger',
      body: 'Hold every payment. Call the title or escrow company at a number you found yourself, not one in the message, before anyone sends money.',
    });
    return { dealId: deal.recordId, dutyId };
  },
});

export const dutyCommands = [
  dutySetStatus,
  dutyAddEvidence,
  dutyWithdrawEvidence,
  dutyAssign,
  dutyAcknowledge,
  dutyComplete,
  dutyCompleteWithException,
  dutyWaive,
  dutyCancel,
  dutyReopen,
  dutySetDue,
  dutyAdd,
  dealReportWireChange,
];
