/**
 * One duty from a phone's copy (Real Estate round six, step 14): what `realestate.duty.get` answers (what it is, who
 * answers for it, when it's due and why, what finishes it and what's missing, its proof, what it waits on, and its
 * log), worked out from the rows the phone keeps. What the person may do is the server's.
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds it to the server's answer.
 *
 * On a deal kept as its summary (someone who sees every deal, not on this one) the phone has the duty but not its
 * proof, log or waits: `full` is false, and those wait for signal.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { ProofRule, ResolvedDuty } from '../catalog/types';
import { dueRuleDates } from '../dates/due';
import { gapWords, proofGaps, proofItemWords } from '../proof';
import { dueRuleWords } from '../rule-words';
import type { DutyGetOutput } from '../schemas';
import { isDoneDuty, isOverdue, type DutyStatus } from '../states';
import { dealProofFactsOfCopy, evidenceFactsOfCopy, holdsWhole, isoOr } from './deal-facts';
import { byText, iso, ms, text, type CopyDuty, type RealestateCopy } from './synced';

type DutyGet = z.infer<typeof DutyGetOutput>;
export type DutySheet = Omit<DutyGet, 'can'> & { readonly full: boolean };
type WaitLine = DutyGet['waitsOn'][number];

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The duty, or null when the phone doesn't hold it. */
export function dutySheetOfCopy(
  copy: RealestateCopy,
  dutyId: string,
  ctx: { readonly userId: string | null; readonly now: number },
): DutySheet | null {
  let duty: CopyDuty | undefined;
  for (const list of copy.duties.values()) {
    duty = list.find((t) => t.id === dutyId);
    if (duty) break;
  }
  if (!duty) return null;
  const dealId = duty.dealId;
  const deal = copy.deals.get(dealId);
  const full = holdsWhole(copy, dealId, ctx.userId);
  const rows = copy.rows('duties', dealId);
  const row = rows.find((r) => r.id === dutyId)!.data;
  const def = (row.definition ?? {}) as ResolvedDuty;
  const rule = (def.proof ?? null) as ProofRule | null;
  const status = duty.status as DutyStatus;
  const dueAt = duty.dueAt === null ? null : iso(duty.dueAt);
  const who = (id: string | null) =>
    id ? { userId: id, name: copy.user(id) ?? 'Former member' } : null;
  const gaps =
    !full || isDoneDuty(status)
      ? []
      : proofGaps(
          rule,
          evidenceFactsOfCopy(copy, dealId).get(dutyId) ?? [],
          dealProofFactsOfCopy(copy, dealId),
        );

  const documents = new Map(copy.rows('documents', dealId).map((r) => [r.id, r.data]));
  const evidence = full
    ? copy
        .rows('duty_evidence', dealId)
        .filter((e) => text(e.data.duty_id) === dutyId)
        .sort(
          (a, b) => (ms(a.data.added_at) ?? 0) - (ms(b.data.added_at) ?? 0) || byText(a.id, b.id),
        )
        .map(({ id, data: e }) => {
          const kind = text(e.kind) ?? '';
          const documentId = text(e.document_id);
          const fileId = text(e.file_id);
          const appointmentId = text(e.appointment_id);
          const label =
            (documentId ? text(documents.get(documentId)?.title) : null) ??
            (fileId ? copy.file(fileId) : null) ??
            (appointmentId ? copy.appointment(appointmentId) : null) ??
            (kind === 'note'
              ? 'Note'
              : kind === 'attestation'
                ? 'Their word'
                : kind === 'message'
                  ? 'Message'
                  : proofItemWords({ kind: 'file' }));
          return {
            evidenceId: id,
            kind,
            documentId,
            fileId,
            appointmentId,
            messageId: text(e.message_id),
            body: text(e.body),
            label,
            addedBy: who(text(e.added_by)),
            addedAt: isoOr(e.added_at) ?? iso(0),
            withdrawnAt: isoOr(e.withdrawn_at),
            withdrawnReason: text(e.withdrawn_reason),
          };
        })
    : [];

  const log = full
    ? copy
        .rows('duty_log', dealId)
        .filter((l) => text(l.data.duty_id) === dutyId)
        .sort((a, b) => (ms(b.data.at) ?? 0) - (ms(a.data.at) ?? 0) || byText(b.id, a.id))
        .map(({ data: l }) => ({
          at: isoOr(l.at) ?? iso(0),
          what: text(l.what) ?? '',
          actorType: (text(l.actor_type) ?? 'system') as DutyGet['log'][number]['actorType'],
          actor: who(text(l.actor_user_id)),
          before: record(l.before),
          after: record(l.after),
          note: text(l.note),
        }))
    : [];

  // What it waits on and what waits on it, through the deal's links between duties.
  const byId = new Map<string, CopyDuty>();
  for (const list of copy.duties.values()) for (const t of list) byId.set(t.id, t);
  const line = (o: CopyDuty, addedBy: string | null): WaitLine => {
    const oRow = copy.rows('duties', o.dealId).find((r) => r.id === o.id)?.data ?? {};
    return {
      dutyId: o.id,
      title: o.title,
      status: o.status as DutyStatus,
      accountableName: o.accountableUserId ? copy.user(o.accountableUserId) : null,
      dueAt: o.dueAt === null ? null : iso(o.dueAt),
      overdue:
        !isDoneDuty(o.status as DutyStatus) &&
        o.status !== 'draft' &&
        o.dueAt !== null &&
        o.dueAt <= ctx.now,
      waitingOn: o.status === 'waiting_external' ? text(oRow.waiting_on) : null,
      builtIn: !addedBy,
      addedByName: addedBy ? copy.user(addedBy) : null,
    };
  };
  const links = full
    ? copy
        .rows('duty_links', dealId)
        .map(({ id, data }) => ({
          id,
          dutyId: text(data.duty_id) ?? '',
          dependsOnId: text(data.depends_on_id) ?? '',
          addedBy: text(data.added_by),
          at: ms(data.created_at) ?? 0,
        }))
        .filter((l) => l.dutyId === dutyId || l.dependsOnId === dutyId)
        .sort((a, b) => a.at - b.at || byText(a.id, b.id))
    : [];
  const waitsOn = links
    .filter((l) => l.dutyId === dutyId && l.dependsOnId !== dutyId && byId.has(l.dependsOnId))
    .map((l) => line(byId.get(l.dependsOnId)!, l.addedBy));
  const waitingOnThis = links
    .filter((l) => l.dependsOnId === dutyId && l.dutyId !== dutyId && byId.has(l.dutyId))
    .map((l) => line(byId.get(l.dutyId)!, l.addedBy))
    .filter((w) => w.status !== 'cancelled');
  const keys = full ? dueRuleDates(def.due) : [];
  const sameDate = keys.length
    ? [...(copy.duties.get(dealId) ?? [])]
        .sort(
          (a, b) =>
            (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
            a.createdAt - b.createdAt ||
            byText(a.id, b.id),
        )
        .filter((o) => {
          if (o.id === dutyId || isDoneDuty(o.status as DutyStatus)) return false;
          if (waitingOnThis.some((w) => w.dutyId === o.id)) return false;
          const oDef = (rows.find((r) => r.id === o.id)?.data.definition ?? {}) as ResolvedDuty;
          return dueRuleDates(oDef.due).some((k) => keys.includes(k));
        })
        .map((o) => o.title)
    : [];

  const blocker = text(row.blocker);
  const overrideAt = isoOr(row.due_override_at);
  return {
    full,
    duty: {
      dutyId,
      dealId,
      dealName: deal?.name ?? '',
      key: duty.key,
      pass: Number(row.pass ?? 0) || 0,
      title: duty.title,
      behavior: def.behavior ?? '',
      phase: def.phase ?? '',
      tracker: text(row.tracker) ?? '',
      status,
      overdue: isOverdue({ status, dueAt }, ctx.now),
      materiality: duty.materiality,
      automation: text(row.automation) ?? '',
      accountableRole: text(row.accountable_role) ?? '',
      accountable: who(duty.accountableUserId),
      performers: strings(row.performers),
      startedBy: text(row.started_by) ?? '',
      startedAt: isoOr(row.started_at) ?? iso(0),
      dueState: duty.dueState as 'due' | 'none' | 'waiting',
      dueAt,
      dueDate: text(row.due_date),
      dueTime: text(row.due_time),
      dueTrace: list(row.due_trace),
      dueRule: dueRuleWords(def.due),
      warnings: list(row.due_warnings),
      needsDates: strings(row.needs_dates),
      dueSetByHand: overrideAt
        ? { at: overrideAt, reason: text(row.due_override_reason) ?? '' }
        : null,
      blocker: blocker
        ? {
            what: blocker,
            owner: text(row.blocker_owner) ?? '',
            impact: text(row.blocker_impact),
            reviewAt: isoOr(row.blocker_review_at),
          }
        : null,
      waitingOn: text(row.waiting_on),
      waitingSince: isoOr(row.waiting_since),
      chaseAt: isoOr(row.chase_at),
      finishedAt: isoOr(row.finished_at),
      finishReason: text(row.finish_reason),
      exception: row.exception === true,
      acknowledgedAt: isoOr(row.acknowledged_at),
    },
    waitsOn,
    waitingOnThis,
    ifItSlips: {
      waiting: waitingOnThis.filter((w) => !isDoneDuty(w.status)).map((w) => w.title),
      sameDate,
    },
    proof: {
      needs: rule?.items.length ? gapWords(rule, rule.items) : '',
      missing: gaps.length ? gapWords(rule, gaps) : '',
      attestations: (rule?.items ?? []).flatMap((i) => (i.kind === 'attestation' ? [i.words] : [])),
    },
    evidence,
    log,
  };
}
