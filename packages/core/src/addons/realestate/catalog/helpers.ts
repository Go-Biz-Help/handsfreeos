/**
 * Shorthand for the catalog's rows, so each reads as one sentence: when it's created, when it's due, and what
 * finishes it. Browser-safe and pure.
 */
import type { DueRule } from '../dates/due';
import type { KeyDateKey } from '../dates/key-dates';
import type { DealStage } from '../states';
import type {
  DealEvent,
  DealField,
  DocumentKind,
  DutyTrigger,
  ProofItem,
  ProofRule,
} from './types';

// ---------- when it's created ----------

export const stage = (s: DealStage): DutyTrigger => ({ on: 'stage', stage: s });
export const dates = (key: KeyDateKey): DutyTrigger => ({ on: 'dates', key });
export const event = (e: DealEvent): DutyTrigger => ({ on: 'event', event: e });

// ---------- when it's due ----------

export const noDeadline: DueRule = { kind: 'none' };
export const ongoing: DueRule = { kind: 'ongoing' };
/** Hours after it began. */
export const withinHours = (hours: number): DueRule => ({ kind: 'after_start', hours });
/** Days after it began, at 11:59 pm. */
export const withinDays = (days: number): DueRule => ({ kind: 'after_start', days });
/** Business days after it began, at 11:59 pm. */
export const withinBusinessDays = (businessDays: number): DueRule => ({
  kind: 'after_start',
  businessDays,
});
/** On a key date (its own time, else 11:59 pm). */
export const on = (to: KeyDateKey): DueRule => ({ kind: 'relative', to });
/** Days before a key date. */
export const daysBefore = (to: KeyDateKey, days: number): DueRule => ({
  kind: 'relative',
  to,
  days: -days,
});
/** Business days before a key date. */
export const businessDaysBefore = (to: KeyDateKey, businessDays: number): DueRule => ({
  kind: 'relative',
  to,
  businessDays: -businessDays,
});
/** Days after a key date. */
export const daysAfter = (to: KeyDateKey, days: number): DueRule => ({
  kind: 'relative',
  to,
  days,
});
/** Hours before a key date's time. */
export const hoursBefore = (to: KeyDateKey, hours: number): DueRule => ({
  kind: 'relative',
  to,
  hours: -hours,
});
/** Again every so many days. */
export const every = (days: number): DueRule => ({ kind: 'every', days });
export const earliest = (...of: DueRule[]): DueRule => ({ kind: 'earliest', of });

// ---------- what finishes it ----------

export const doc = (documents: DocumentKind[], signed = false): ProofItem =>
  signed ? { kind: 'document', documents, signed } : { kind: 'document', documents };
export const NOTE: ProofItem = { kind: 'note' };
export const FILE: ProofItem = { kind: 'file' };
export const APPOINTMENT: ProofItem = { kind: 'appointment' };
export const MESSAGE: ProofItem = { kind: 'message' };
export const attest = (words: string): ProofItem => ({ kind: 'attestation', words });
export const datesIn = (...keys: KeyDateKey[]): ProofItem => ({ kind: 'dates', keys });
export const field = (f: DealField): ProofItem => ({ kind: 'deal_field', field: f });
export const anyOf = (...items: ProofItem[]): ProofRule => ({ mode: 'any', items });
export const allOf = (...items: ProofItem[]): ProofRule => ({ mode: 'all', items });
/** One thing, which must be there. */
export const just = (item: ProofItem): ProofRule => ({ mode: 'all', items: [item] });
