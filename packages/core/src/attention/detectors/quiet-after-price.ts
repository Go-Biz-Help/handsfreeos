/**
 * Went quiet after a price (Automations' pipeline rows): the customer heard a price — a quote, or a price in a
 * text, an email or a call — and hasn't said a word since. Two days on, a person is asked to call; the follow-up
 * texts carry on as they were.
 *
 * It stands down when they write back, the deal closes, or the price was a quote that has waited long enough for
 * "Quotes with no decision" (`estimate_waiting`) to take it over, and it lets go after thirty days.
 */
import { chip } from '../chips';
import { leadIsOpen, leadValue, type BusinessFacts, type LeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

export const QUIET_AFTER_PRICE_DAYS = 2;
export const QUIET_AFTER_PRICE_UNTIL_DAYS = 30;

export interface QuietAfterPriceFacts {
  readonly business: BusinessFacts;
  readonly lead: LeadFacts;
  /** The latest price they heard, or null. */
  readonly price: {
    readonly at: string;
    /** "$450". */
    readonly amount: string;
    readonly via: 'quote' | 'text' | 'email' | 'call';
    /** For a quote: whether it's still waiting on them (sent, not accepted, declined or withdrawn). */
    readonly open: boolean;
  } | null;
  /** Their latest message or call to the business, or null. */
  readonly heardFromAt: string | null;
  /** "Quotes with no decision" takes a quote over after this many days. */
  readonly estimateWaitingDays: number;
}

const VIA = { quote: 'quote', text: 'by text', email: 'by email', call: 'on a call' } as const;

function assess(f: QuietAfterPriceFacts, settings: AttentionSettings, now: number): Assessment {
  const p = f.price;
  if (!p || !leadIsOpen(f.lead) || (p.via === 'quote' && !p.open)) return null;
  const since = ms(p.at);
  if (f.heardFromAt && ms(f.heardFromAt) > since) return null;
  const until = Math.min(
    since + QUIET_AFTER_PRICE_UNTIL_DAYS * DAY,
    p.via === 'quote' ? since + f.estimateWaitingDays * DAY : Infinity,
  );
  const opens = since + QUIET_AFTER_PRICE_DAYS * DAY;
  if (now >= until) return null;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('quiet_after_price', { lead: f.lead.id, at: p.at }),
    since,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(f.lead, f.business, settings),
    probability: 0.5,
    confidence: 0.7,
    reasons: [chip('price', `${p.amount} ${VIA[p.via]}`)],
    assignee: f.lead.assigneeUserId,
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<QuietAfterPriceFacts>('quiet_after_price', assess);
