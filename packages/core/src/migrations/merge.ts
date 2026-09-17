/**
 * Deciding whether somebody arriving from the old system is somebody already here.
 *
 * The rule the whole thing turns on: **a name is never enough.** Two Dave Smiths in a plumbing business is
 * Tuesday. A phone number is a person; a name is a coincidence waiting to happen. So the ladder below climbs
 * from the evidence that identifies a person to the evidence that merely suggests one, and it stops climbing
 * the moment two rungs disagree — because a wrong merge silently welds two customers' histories together, and
 * that is far worse than one duplicate somebody can join later.
 *
 * Everything here is pure and versioned. `MATCH_RULES_VERSION` goes up whenever a decision would change, so a
 * merge made months ago can still be explained by the rules that made it.
 */
import type { CountryCode } from 'libphonenumber-js';
import { normalizePhone } from '../crm/phone';

export const MATCH_RULES_VERSION = 1;

/** Which rung matched. In descending order of how much it proves. */
export type MatchRule =
  | 'mapping' // already brought across once: the source mapping, which beats everything
  | 'phone' // the main number, the same to the digit
  | 'email' // the main address, the same
  | 'extra_phone' // one of their other numbers
  | 'extra_email' // one of their other addresses
  | 'corroborating' // two weaker signals agreeing (company and address, say)
  | 'conflict'; // the email says one person, the phone says another

export interface IncomingContact {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly extraEmails?: readonly string[];
  readonly extraPhones?: readonly string[];
  readonly companyName?: string | null;
  readonly postalCode?: string | null;
  readonly defaultCountry?: CountryCode;
}

/** A person already in the business that might be the same one. */
export interface ExistingContact {
  readonly id: string;
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly extraEmails?: readonly string[];
  readonly extraPhones?: readonly string[];
  readonly companyName?: string | null;
  readonly postalCode?: string | null;
}

export type MergeDecision =
  | { readonly kind: 'create'; readonly reason: 'no_match' }
  | {
      readonly kind: 'merge';
      readonly targetId: string;
      readonly rule: MatchRule;
      readonly score: number;
      readonly evidence: Record<string, unknown>;
    }
  | {
      readonly kind: 'review';
      /** Everyone it could be; the review screen shows them all. */
      readonly targetIds: readonly string[];
      readonly rule: MatchRule;
      readonly score: number;
      readonly evidence: Record<string, unknown>;
    };

const email = (v: string | null | undefined): string | null => {
  const t = v?.trim().toLowerCase();
  return t ? t : null;
};
const phone = (v: string | null | undefined, country?: CountryCode): string | null =>
  v ? normalizePhone(v, country) : null;
const norm = (v: string | null | undefined): string | null => {
  const t = v?.trim().toLowerCase().replace(/\s+/g, ' ');
  return t ? t : null;
};

/** How sure each rung is, out of 100. Only 90 and over merges on its own. */
const SCORES: Record<MatchRule, number> = {
  mapping: 100,
  phone: 95,
  email: 92,
  extra_phone: 80,
  extra_email: 78,
  corroborating: 60,
  conflict: 0,
};

/** At or above this, a match is made without asking. Below it, a person decides. */
export const AUTO_MERGE_SCORE = 90;

/**
 * Walks the ladder. Two things it deliberately will not do:
 *   - merge when a rung matches more than one person here (which one? nobody knows, so nobody guesses);
 *   - merge when the email points at one person and the phone at another — that is the clearest possible
 *     sign that a human should look, and it becomes a conflict rather than a coin toss.
 */
export function decideMerge(
  incoming: IncomingContact,
  candidates: readonly ExistingContact[],
): MergeDecision {
  if (candidates.length === 0) return { kind: 'create', reason: 'no_match' };
  const country = incoming.defaultCountry;
  const wantEmail = email(incoming.email);
  const wantPhone = phone(incoming.phone, country);
  const wantExtraEmails = new Set(
    (incoming.extraEmails ?? []).map(email).filter(Boolean) as string[],
  );
  const wantExtraPhones = new Set(
    (incoming.extraPhones ?? []).map((p) => phone(p, country)).filter(Boolean) as string[],
  );

  const on = (rule: MatchRule): ExistingContact[] =>
    candidates.filter((x) => {
      switch (rule) {
        case 'phone':
          return !!wantPhone && phone(x.phoneE164, country) === wantPhone;
        case 'email':
          return !!wantEmail && email(x.email) === wantEmail;
        case 'extra_phone': {
          const theirs = [x.phoneE164, ...(x.extraPhones ?? [])]
            .map((p) => phone(p, country))
            .filter(Boolean) as string[];
          const mine = [wantPhone, ...wantExtraPhones].filter(Boolean) as string[];
          return theirs.some((t) => mine.includes(t));
        }
        case 'extra_email': {
          const theirs = [x.email, ...(x.extraEmails ?? [])].map(email).filter(Boolean) as string[];
          const mine = [wantEmail, ...wantExtraEmails].filter(Boolean) as string[];
          return theirs.some((t) => mine.includes(t));
        }
        case 'corroborating': {
          const company = norm(incoming.companyName);
          const zip = norm(incoming.postalCode);
          const both =
            (!!company && norm(x.companyName) === company ? 1 : 0) +
            (!!zip && norm(x.postalCode) === zip ? 1 : 0);
          return both >= 2;
        }
        default:
          return false;
      }
    });

  const byPhone = on('phone');
  const byEmail = on('email');

  // The one case that always goes to a person: two strong signals, two different people.
  if (byPhone.length === 1 && byEmail.length === 1 && byPhone[0]!.id !== byEmail[0]!.id) {
    return {
      kind: 'review',
      targetIds: [byPhone[0]!.id, byEmail[0]!.id],
      rule: 'conflict',
      score: SCORES.conflict,
      evidence: {
        reason: 'The phone number matches one customer and the email matches another.',
        phoneMatch: byPhone[0]!.id,
        emailMatch: byEmail[0]!.id,
        phone: wantPhone,
        email: wantEmail,
      },
    };
  }

  for (const rule of ['phone', 'email', 'extra_phone', 'extra_email', 'corroborating'] as const) {
    const hits = rule === 'phone' ? byPhone : rule === 'email' ? byEmail : on(rule);
    if (hits.length === 0) continue;
    const score = SCORES[rule];
    const evidence: Record<string, unknown> = { rule, phone: wantPhone, email: wantEmail };
    if (hits.length > 1) {
      // Ambiguous: the same number on two records here. Never guessed.
      return {
        kind: 'review',
        targetIds: hits.map((h) => h.id),
        rule,
        score,
        evidence: { ...evidence, reason: 'More than one customer here matches.' },
      };
    }
    const target = hits[0]!;
    return score >= AUTO_MERGE_SCORE
      ? { kind: 'merge', targetId: target.id, rule, score, evidence }
      : { kind: 'review', targetIds: [target.id], rule, score, evidence };
  }
  return { kind: 'create', reason: 'no_match' };
}

/**
 * What to write onto a customer who was already here.
 *
 * The bias is towards what is here: somebody has been working in HandsFreeOS, and an import arriving later
 * must not quietly undo that. So a blank here is filled from the old system, a value here is kept, and the
 * old system's value is recorded beside it either way — which is what lets a person see the difference and
 * choose, instead of finding out months later that a phone number changed by itself.
 */
export interface FieldMergeResult {
  /** Fields to write: the ones that were empty here. */
  readonly updates: Record<string, unknown>;
  /** What the old system said for fields we did not take, kept for the report and the review queue. */
  readonly kept: Record<string, { readonly here: unknown; readonly there: unknown }>;
}

export function mergeScalarFields(
  here: Readonly<Record<string, unknown>>,
  there: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): FieldMergeResult {
  const updates: Record<string, unknown> = {};
  const kept: Record<string, { here: unknown; there: unknown }> = {};
  for (const f of fields) {
    const a = here[f];
    const b = there[f];
    const bEmpty = b === null || b === undefined || (typeof b === 'string' && b.trim() === '');
    if (bEmpty) continue;
    const aEmpty = a === null || a === undefined || (typeof a === 'string' && a.trim() === '');
    if (aEmpty) updates[f] = b;
    else if (a !== b) kept[f] = { here: a, there: b };
  }
  return { updates, kept };
}

/** Tags, extra numbers and extra addresses are added to, never replaced. Order is stable so reruns are quiet. */
export function unionValues(
  here: readonly string[],
  there: readonly string[],
  normalize: (v: string) => string | null = (v) => v.trim() || null,
): string[] {
  const seen = new Map<string, string>();
  for (const v of [...here, ...there]) {
    const key = normalize(v);
    if (key && !seen.has(key.toLowerCase())) seen.set(key.toLowerCase(), key);
  }
  return [...seen.values()];
}

export type SmsConsent = 'unknown' | 'opted_in' | 'opted_out';

/**
 * Which agreement wins when the same person has two.
 *
 * "Opted out" always wins, from either side and whichever is newer: somebody who told either system to stop
 * has told us to stop. Between the other two, a recorded agreement beats no record at all — "unknown" is the
 * absence of information, not a refusal, and throwing away a real opt-in would cost the business the right to
 * text a customer who actually said yes.
 */
export function stricterConsent(here: SmsConsent, there: SmsConsent): SmsConsent {
  if (here === 'opted_out' || there === 'opted_out') return 'opted_out';
  if (here === 'opted_in' || there === 'opted_in') return 'opted_in';
  return 'unknown';
}
