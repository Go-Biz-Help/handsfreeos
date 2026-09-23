/**
 * The website changed (Automations' "Website changed"): the weekly re-read of the business's website found pages
 * that changed since the AI last read them, and proposed updates to what the AI knows (prices, hours, services).
 * The card asks a person to look at them; nothing changes until they accept. It goes once none are waiting.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, ms, type Assessment } from './define';

export interface WebsiteChangedFacts {
  readonly business: BusinessFacts;
  readonly scan: {
    readonly id: string;
    /** Whether it was the weekly re-read (a person's own scan is theirs to look at already). */
    readonly automatic: boolean;
    readonly finishedAt: string | null;
    readonly pagesChanged: number;
    /** Updates it proposed that nobody has accepted or rejected yet. */
    readonly waiting: number;
  };
}

function assess(f: WebsiteChangedFacts, settings: AttentionSettings, now: number): Assessment {
  const s = f.scan;
  if (!s.automatic || !s.finishedAt || s.waiting === 0) return null;
  const since = Math.min(ms(s.finishedAt), now);
  const pages = s.pagesChanged === 1 ? '1 page changed' : `${s.pagesChanged} pages changed`;
  const updates = s.waiting === 1 ? '1 update' : `${s.waiting} updates`;
  return detection({
    fingerprint: fingerprintOf('website_changed', { scan: s.id }),
    since,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(null, f.business, settings),
    probability: 0.6,
    confidence: 0.8,
    reasons: [chip('site_changed', `${pages} · ${updates} to review`)],
    assignee: null,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<WebsiteChangedFacts>('website_changed', assess);
