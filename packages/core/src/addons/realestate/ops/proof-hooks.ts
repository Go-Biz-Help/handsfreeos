/**
 * The duty hooks, step 13 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): what round two's
 * records add to the catalog duties they answer, through this one helper. A tour is B-05's appointment, a client's
 * feedback is B-08's note, a CMA and an offer are linked to B-10/B-15 and B-11/B-16, a lost offer's note is B-13's,
 * inspections and the repair request answer B-19 to B-25, and a document of a kind counts for every duty whose
 * proof names that kind (the agreement, the preapproval, the financing rows).
 *
 * - **Proof only.** Nothing here finishes a duty: a person still marks it done, and its proof is checked then as
 *   always. The catalog and its version don't change.
 * - **Once.** The same proof isn't added to a duty twice, and a duty that's done, waived or cancelled is left alone.
 * - **Taken back with its record**: a canceled tour's appointment no longer counts.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import type { ProofItem, ProofRule } from '../catalog/types';
import { OPEN_DUTY_STATUSES } from '../states';
import { documents, duties, dutyEvidence } from '../tables';
import { actorUserId, type Deal } from './common';
import { dutyEvent, logLine, type DutyRow } from './duties';

/** The events a command that adds or takes back proof declares. */
export const PROOF_EVENTS = [
  'realestate.duty.evidence_added',
  'realestate.duty.evidence_withdrawn',
] as const;

export interface Proof {
  readonly kind: 'document' | 'appointment' | 'note' | 'attestation' | 'record';
  readonly documentId?: string | null;
  readonly appointmentId?: string | null;
  readonly body?: string | null;
  /** For a record: which of the add-on's rows it is (a tour, a CMA, an offer). */
  readonly refKind?: string | null;
  readonly refId?: string | null;
}

/** Which duties it's for: by key, by a document kind their proof names, or both. */
export interface ProofTarget {
  readonly keys?: readonly string[];
  readonly documentKind?: string;
}

const namesDocument = (rule: ProofRule | null | undefined, kind: string): boolean =>
  (rule?.items ?? []).some(
    (i: ProofItem) => i.kind === 'document' && (i.documents as readonly string[]).includes(kind),
  );

async function openDuties(
  ctx: CommandContext,
  deal: Deal,
  target: ProofTarget,
): Promise<DutyRow[]> {
  const list = await ctx.tx
    .select()
    .from(duties)
    .where(
      and(
        eq(duties.dealRecordId, deal.recordId),
        inArray(duties.status, [...OPEN_DUTY_STATUSES]),
        ...(target.keys ? [inArray(duties.dutyKey, [...target.keys])] : []),
      ),
    );
  return target.documentKind
    ? list.filter((d) =>
        namesDocument((d.definition as { proof?: ProofRule | null }).proof, target.documentKind!),
      )
    : list;
}

const same = (e: typeof dutyEvidence.$inferSelect, p: Proof) =>
  e.kind === p.kind &&
  (p.documentId ? e.documentId === p.documentId : true) &&
  (p.appointmentId ? e.appointmentId === p.appointmentId : true) &&
  (p.refId ? e.refId === p.refId && e.refKind === p.refKind : true) &&
  (!p.documentId && !p.appointmentId && !p.refId ? e.body === (p.body ?? null) : true);

/** Adds the proof to each open duty it's for, once. How many it was added to. */
export async function addProof(
  ctx: CommandContext,
  deal: Deal,
  target: ProofTarget,
  proof: Proof,
): Promise<number> {
  const list = await openDuties(ctx, deal, target);
  if (!list.length) return 0;
  const had = await ctx.tx
    .select()
    .from(dutyEvidence)
    .where(
      and(
        inArray(
          dutyEvidence.dutyId,
          list.map((d) => d.id),
        ),
        isNull(dutyEvidence.withdrawnAt),
      ),
    );
  let added = 0;
  for (const duty of list) {
    if (had.some((e) => e.dutyId === duty.id && same(e, proof))) continue;
    const [row] = await ctx.tx
      .insert(dutyEvidence)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        dutyId: duty.id,
        kind: proof.kind,
        documentId: proof.documentId ?? null,
        appointmentId: proof.appointmentId ?? null,
        body: proof.body?.slice(0, 4000) ?? null,
        refKind: proof.kind === 'record' ? (proof.refKind ?? null) : null,
        refId: proof.kind === 'record' ? (proof.refId ?? null) : null,
        addedBy: actorUserId(ctx),
        addedAt: changeMoment(ctx.meta),
      })
      .returning({ id: dutyEvidence.id });
    await logLine(ctx, duty, 'evidence_added', {
      after: { evidenceId: row!.id, kind: proof.kind, from: proof.refKind ?? proof.kind },
    });
    await dutyEvent(ctx, 'realestate.duty.evidence_added', duty, deal, {
      after: { proof: proof.kind },
      payload: { evidenceId: row!.id, kind: proof.kind, automatic: true },
    });
    added += 1;
  }
  return added;
}

/** A document of a kind on the deal counts for every open duty whose proof names that kind. */
export async function documentProof(
  ctx: CommandContext,
  deal: Deal,
  documentId: string,
): Promise<number> {
  const [doc] = await ctx.tx
    .select({ kind: documents.kind, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.dealRecordId, deal.recordId)));
  if (!doc) return 0;
  return addProof(ctx, deal, { documentKind: doc.kind }, { kind: 'document', documentId });
}

/** Takes back the proof a record gave, with the reason, from duties still open. */
export async function withdrawProof(
  ctx: CommandContext,
  deal: Deal,
  match: { readonly appointmentId?: string; readonly refId?: string },
  reason: string,
): Promise<number> {
  const open = await openDuties(ctx, deal, {});
  if (!open.length) return 0;
  const list = await ctx.tx
    .select()
    .from(dutyEvidence)
    .where(
      and(
        inArray(
          dutyEvidence.dutyId,
          open.map((d) => d.id),
        ),
        isNull(dutyEvidence.withdrawnAt),
        match.appointmentId
          ? eq(dutyEvidence.appointmentId, match.appointmentId)
          : eq(dutyEvidence.refId, match.refId!),
      ),
    );
  for (const e of list) {
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(dutyEvidence)
      .set({
        withdrawnAt: at,
        withdrawnBy: actorUserId(ctx),
        withdrawnReason: reason.slice(0, 500),
      })
      .where(eq(dutyEvidence.id, e.id));
    const duty = open.find((d) => d.id === e.dutyId)!;
    await logLine(ctx, duty, 'evidence_withdrawn', { after: { evidenceId: e.id }, note: reason });
    await dutyEvent(ctx, 'realestate.duty.evidence_withdrawn', duty, deal, {
      payload: { evidenceId: e.id, automatic: true },
    });
  }
  return list.length;
}
