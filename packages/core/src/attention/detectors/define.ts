/**
 * What every detector shares: the on/off switch per kind, the shape of what it returns, and small time helpers.
 * A detector is pure: the same facts, settings and moment always give the same answer.
 */
import { chip, moneyLabel, sortChips } from '../chips';
import type { ValueFacts } from '../facts';
import type { AttentionKind } from '../kinds';
import type { AttentionSettings } from '../settings';
import type { AttentionChip, Detection } from '../types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ms = (iso: string): number => Date.parse(iso);
/** One ISO form for a moment, so fingerprints don't change with how a time was written. */
export const stamp = (t: number): string => new Date(t).toISOString();

/** Not holding yet, but it will at `wakeAt` (ms) unless something else changes first. */
export interface Pending {
  readonly wakeAt: number;
}
export type Assessment = Detection | Pending | null;

const isDetection = (a: Assessment): a is Detection => a !== null && 'fingerprint' in a;

export interface AttentionDetector<F> {
  readonly kind: AttentionKind;
  /** What holds now, or null. */
  readonly detect: (facts: F, settings: AttentionSettings, now: Date) => Detection | null;
  /**
   * While nothing holds: when it will begin to hold by time alone (15 open-hours minutes pass, an appointment
   * enters its window), so the worker can look again then; else null.
   */
  readonly wakeAt: (facts: F, settings: AttentionSettings, now: Date) => string | null;
}

export function defineDetector<F>(
  kind: AttentionKind,
  assess: (facts: F, settings: AttentionSettings, now: number) => Assessment,
): AttentionDetector<F> {
  const run = (facts: F, settings: AttentionSettings, now: Date): Assessment =>
    settings.kinds[kind] ? assess(facts, settings, now.getTime()) : null;
  return {
    kind,
    detect: (facts, settings, now) => {
      const a = run(facts, settings, now);
      return isDetection(a) ? a : null;
    },
    wakeAt: (facts, settings, now) => {
      const a = run(facts, settings, now);
      return a !== null && !isDetection(a) ? stamp(a.wakeAt) : null;
    },
  };
}

export interface DetectionParts {
  readonly fingerprint: string;
  readonly since: number | null;
  readonly urgentFrom: number | null;
  readonly dueAt: number | null;
  readonly value: ValueFacts;
  readonly probability: number;
  readonly confidence: number;
  readonly reasons: readonly AttentionChip[];
  readonly assignee: string | null;
  readonly recheckAt: number | null;
}

const unit = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
const iso = (t: number | null) => (t === null ? null : stamp(t));

export function detection(p: DetectionParts): Detection {
  return {
    fingerprint: p.fingerprint,
    since: iso(p.since),
    urgentFrom: iso(p.urgentFrom),
    dueAt: iso(p.dueAt),
    value: p.value.value,
    valueIsEstimate: p.value.valueIsEstimate,
    moneyKey: p.value.moneyKey,
    probability: unit(p.probability),
    confidence: unit(p.confidence),
    reasons: sortChips(p.reasons),
    assignee: p.assignee,
    recheckAt: iso(p.recheckAt),
  };
}

/** The value chip, for a real value only: an estimate isn't shown as money. */
export function valueChips(v: ValueFacts): AttentionChip[] {
  return v.valueIsEstimate ? [] : [chip('value', moneyLabel(v.value))];
}

/** A moment still ahead, or null. */
export const ahead = (t: number | null, now: number): number | null =>
  t !== null && t > now ? t : null;

/** The earliest of some moments, or null. */
export function earliest(...ts: readonly (number | null)[]): number | null {
  const known = ts.filter((t): t is number => t !== null);
  return known.length ? Math.min(...known) : null;
}

/** At most `max` characters, with an ellipsis. */
export const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
