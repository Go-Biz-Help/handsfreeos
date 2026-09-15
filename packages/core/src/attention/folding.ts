/**
 * One card per lead. Of the lead kinds that hold for one lead, only the first in LEAD_PRECEDENCE (hot, then
 * unanswered, then stale, then missing next action) stays; the others fold into it as reason chips, so nothing
 * shows twice and no lead's dollars count twice. A lead's card also covers its customer's waiting conversation, so
 * customer_waiting doesn't open for someone who has a lead card: its waiting chip joins the card, the card turns
 * urgent when the wait does, and a customer who starts waiting brings back a dismissed card.
 */
import { sortChips } from './chips';
import { combineFingerprints } from './fingerprint';
import { isLeadKind, LEAD_PRECEDENCE, type AttentionKind, type LeadAttentionKind } from './kinds';
import type { AttentionCandidate, Detection } from './types';

export interface FoldedCandidate extends AttentionCandidate {
  /** What folded into it. The loader decides what becomes of those items' own rows. */
  readonly folded: readonly { readonly kind: AttentionKind; readonly subjectId: string }[];
}

const precedence = (kind: AttentionKind) => LEAD_PRECEDENCE.indexOf(kind as LeadAttentionKind);

const earliestIso = (list: readonly (string | null)[]): string | null =>
  list.reduce<string | null>(
    (best, x) => (x !== null && (best === null || Date.parse(x) < Date.parse(best)) ? x : best),
    null,
  );

function merge(top: AttentionCandidate, folded: readonly AttentionCandidate[]): FoldedCandidate {
  if (folded.length === 0) return { ...top, folded: [] };
  const all: Detection[] = [top.detection, ...folded.map((f) => f.detection)];
  const waiting = folded
    .filter((f) => f.kind === 'customer_waiting')
    .map((f) => f.detection.fingerprint);
  return {
    ...top,
    folded: folded.map((f) => ({ kind: f.kind, subjectId: f.subjectId })),
    detection: {
      ...top.detection,
      fingerprint: combineFingerprints(top.detection.fingerprint, waiting),
      urgentFrom: earliestIso(all.map((d) => d.urgentFrom)),
      recheckAt: earliestIso(all.map((d) => d.recheckAt)),
      reasons: sortChips([
        ...top.detection.reasons,
        ...folded.flatMap((f) => f.detection.reasons.filter((r) => r.code !== 'value')),
      ]),
    },
  };
}

/** Applies precedence and folding to every candidate for a business (or for the subjects being reconciled). */
export function foldCandidates(candidates: readonly AttentionCandidate[]): FoldedCandidate[] {
  const byLead = new Map<string, AttentionCandidate[]>();
  const waiting: AttentionCandidate[] = [];
  const rest: AttentionCandidate[] = [];
  for (const c of candidates) {
    if (isLeadKind(c.kind)) {
      const key = c.leadId ?? c.subjectId;
      byLead.set(key, [...(byLead.get(key) ?? []), c]);
    } else if (c.kind === 'customer_waiting' && c.personId) waiting.push(c);
    else rest.push(c);
  }

  const cards: { top: AttentionCandidate; folded: AttentionCandidate[] }[] = [];
  for (const group of byLead.values()) {
    const [top, ...others] = [...group].sort((a, b) => precedence(a.kind) - precedence(b.kind));
    cards.push({ top: top!, folded: others });
  }

  // A customer with more than one lead card: the waiting conversation joins the highest-precedence card, then the
  // most valuable, then the first by lead id.
  const hostOf = new Map<string, { top: AttentionCandidate; folded: AttentionCandidate[] }>();
  const ordered = [...cards].sort(
    (a, b) =>
      precedence(a.top.kind) - precedence(b.top.kind) ||
      b.top.detection.value - a.top.detection.value ||
      (a.top.subjectId < b.top.subjectId ? -1 : a.top.subjectId > b.top.subjectId ? 1 : 0),
  );
  for (const card of ordered) {
    const person = card.top.personId;
    if (person && !hostOf.has(person)) hostOf.set(person, card);
  }
  for (const w of waiting) {
    const host = hostOf.get(w.personId!);
    if (host) host.folded.push(w);
    else rest.push(w);
  }

  return [...cards.map((c) => merge(c.top, c.folded)), ...rest.map((c) => ({ ...c, folded: [] }))];
}
