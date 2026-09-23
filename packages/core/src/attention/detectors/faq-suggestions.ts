/**
 * A question customers keep asking (Automations' "FAQ suggestions"): the AI teammate couldn't answer it, and it
 * has now come up three times (the knowledge base's gap suggestions, grouped as they come in). A person types the
 * answer once and it's saved to what the AI knows. It goes when the suggestion is answered or turned down.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { clip, defineDetector, detection, ms, type Assessment } from './define';

/** How many times it has to come up. */
export const FAQ_SUGGESTION_MIN_ASKS = 3;

export interface FaqSuggestionsFacts {
  readonly business: BusinessFacts;
  readonly suggestion: {
    readonly id: string;
    readonly question: string;
    /** How many times it has been asked. */
    readonly asked: number;
    readonly status: 'pending' | 'accepted' | 'rejected';
    readonly createdAt: string;
  };
}

function assess(f: FaqSuggestionsFacts, settings: AttentionSettings, now: number): Assessment {
  const q = f.suggestion;
  if (q.status !== 'pending' || q.asked < FAQ_SUGGESTION_MIN_ASKS) return null;
  return detection({
    // A new ask doesn't bring back a card someone dismissed: the question is the same.
    fingerprint: fingerprintOf('faq_suggestions', { suggestion: q.id }),
    since: Math.min(ms(q.createdAt), now),
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.6,
    confidence: 0.8,
    reasons: [chip('asked', `“${clip(q.question, 80)}” · asked ${q.asked} times`)],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<FaqSuggestionsFacts>('faq_suggestions', assess);
