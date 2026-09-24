/**
 * The AI was corrected (Automations' "Learn from corrections"): someone edited or rejected one of the AI teammate's
 * replies, and the worker made one line of guidance of it (app.teammate_lessons) — from the first correction that
 * teaches it something, not the third. The card offers it: "Add to what the AI knows" puts it in the business's
 * policies, which the AI reads; dismissing says no. When the line goes against what the AI already knows, the card
 * says where and asks which is right: "Use the new one" changes the old words, and dismissing keeps them. Either
 * way it's done.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, ms, type Assessment } from './define';

export interface AiCorrectionsFacts {
  readonly business: BusinessFacts;
  readonly lesson: {
    readonly id: string;
    readonly teammateId: string;
    readonly line: string;
    readonly why: string | null;
    /** How many corrections it was made of. */
    readonly corrections: number;
    readonly status: 'open' | 'applied' | 'dismissed';
    readonly createdAt: string;
    /** Where what the AI knows says otherwise, and the words there; null when nothing does. */
    readonly conflict?: { readonly where: string; readonly existing: string } | null;
  };
}

/** “Corrected once” or “Corrected 3 times”. */
const correctedWords = (n: number) => (n === 1 ? 'Corrected once' : `Corrected ${n} times`);
/** The words that say otherwise, short enough for a chip. */
const clip = (s: string) => (s.length <= 80 ? s : `${s.slice(0, 79).trimEnd()}…`);

function assess(f: AiCorrectionsFacts, settings: AttentionSettings, now: number): Assessment {
  const l = f.lesson;
  if (l.status !== 'open') return null;
  const since = Math.min(ms(l.createdAt), now);
  return detection({
    fingerprint: fingerprintOf('ai_corrections', { lesson: l.id }),
    since,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.6,
    confidence: 0.7,
    reasons: [
      ...(l.conflict
        ? [chip('knows_otherwise', `${l.conflict.where} says “${clip(l.conflict.existing)}”`)]
        : []),
      chip('corrected', `${correctedWords(l.corrections)} · “${l.line}”`),
    ],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<AiCorrectionsFacts>('ai_corrections', assess);
