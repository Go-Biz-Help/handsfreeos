/**
 * What finishes a duty (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties"; spec §22 "Evidence rule"): the
 * proof its rule asks for, against what's been added to it and what the deal holds. A verbal "done" never closes a
 * duty whose rule asks for an invoice and a photo; a message counts only where the rule allows one. Browser-safe
 * and pure: the duty drawer shows what's missing with the same words the refusal uses.
 */
import { DEAL_FIELDS, DOCUMENT_KINDS, type DealField, type DocumentKind } from './catalog/types';
import type { ProofItem, ProofRule } from './catalog/types';
import { KEY_DATES, type KeyDateKey } from './dates/key-dates';

/** One piece of proof on a duty, as the check needs it. */
export interface EvidenceFact {
  readonly kind:
    | 'document'
    | 'file'
    | 'note'
    | 'attestation'
    | 'appointment'
    | 'message'
    | 'dates'
    | 'deal_field';
  /** For a document: its kind, and whether it's signed. */
  readonly documentKind?: string | null;
  readonly signed?: boolean;
  /** Taken back: it doesn't count. */
  readonly withdrawn?: boolean;
}

/** What the deal itself holds that some rules ask for. */
export interface DealProofFacts {
  readonly confirmedDates: ReadonlySet<KeyDateKey>;
  readonly fields: ReadonlySet<DealField>;
}

/** Whether one item of a rule is met. */
export function itemMet(
  item: ProofItem,
  evidence: readonly EvidenceFact[],
  deal: DealProofFacts,
): boolean {
  const live = evidence.filter((e) => !e.withdrawn);
  switch (item.kind) {
    case 'document':
      return live.some(
        (e) =>
          e.kind === 'document' &&
          (item.documents as readonly string[]).includes(e.documentKind ?? '') &&
          (!item.signed || e.signed === true),
      );
    case 'file':
      // A document on the deal is one of its files.
      return live.some((e) => e.kind === 'file' || e.kind === 'document');
    case 'note':
    case 'attestation':
    case 'appointment':
    case 'message':
      return live.some((e) => e.kind === item.kind);
    case 'dates':
      return item.keys.every((k) => deal.confirmedDates.has(k));
    case 'deal_field':
      return deal.fields.has(item.field);
  }
}

/**
 * What's still missing: for `all`, every item not met; for `any`, every item when none is met (any one of them
 * would do). Nothing when there's no rule.
 */
export function proofGaps(
  rule: ProofRule | null | undefined,
  evidence: readonly EvidenceFact[],
  deal: DealProofFacts,
): ProofItem[] {
  if (!rule || rule.items.length === 0) return [];
  const unmet = rule.items.filter((i) => !itemMet(i, evidence, deal));
  if (rule.mode === 'all') return unmet;
  return unmet.length === rule.items.length ? [...rule.items] : [];
}

const list = (words: readonly string[], join: 'and' | 'or') =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} ${join} ${words[words.length - 1]}`;

const article = (w: string) => (/^[AEIOU]/i.test(w) ? `an ${w}` : `a ${w}`);

/** One item as a sentence says it: "a signed Purchase contract", "the closing date confirmed". */
export function proofItemWords(item: ProofItem): string {
  switch (item.kind) {
    case 'document': {
      const kinds = item.documents.map((k: DocumentKind) => DOCUMENT_KINDS[k] ?? k);
      const one = list(kinds, 'or');
      return item.signed ? `a signed ${one}` : article(one);
    }
    case 'file':
      return 'a file';
    case 'note':
      return 'a note of what was done';
    case 'attestation':
      return `your word that “${item.words}”`;
    case 'appointment':
      return 'the appointment';
    case 'message':
      return 'a message to or from someone on the deal';
    case 'dates':
      return `${list(
        item.keys.map((k) => KEY_DATES[k].label.toLowerCase()),
        'and',
      )} confirmed`;
    case 'deal_field':
      return `the ${DEAL_FIELDS[item.field].toLowerCase()} filled in`;
  }
}

/** What's missing, in one phrase: "a signed Inspection report and a note of what was done". */
export function gapWords(rule: ProofRule | null | undefined, gaps: readonly ProofItem[]): string {
  return list(gaps.map(proofItemWords), rule?.mode === 'any' && gaps.length > 1 ? 'or' : 'and');
}
