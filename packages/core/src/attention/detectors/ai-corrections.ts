/**
 * The AI keeps being corrected (Automations' "Repeated corrections"): people edited or rejected three or more of
 * the AI teammate's replies in two weeks for the same thing, and the worker made one line of guidance of it
 * (app.teammate_lessons). The card offers it: "Add to what the AI knows" puts it in the business's policies, which
 * the AI reads; dismissing says no. Either way it's done.
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
  };
}

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
    reasons: [chip('corrected', `Corrected ${l.corrections} times · “${l.line}”`)],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<AiCorrectionsFacts>('ai_corrections', assess);
