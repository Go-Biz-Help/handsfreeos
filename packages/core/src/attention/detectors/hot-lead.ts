/**
 * A hot lead: the lead is waiting on the business (nobody has reached out yet, or their message waits for a reply)
 * and has one strong signal (qualified, or ready-to-book wording) or two weak ones (its own value at the hot
 * threshold, a repeat customer, came in today). Imports never count as new, and a "not a fit" lead is never hot.
 * Urgent once it has waited the hot threshold (plain minutes).
 */
import { chip, sinceChip } from '../chips';
import {
  leadIsOpen,
  leadProbability,
  leadValue,
  neverContacted,
  type BusinessFacts,
  type LeadFacts,
} from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import {
  cameInToday,
  nextLocalMidnight,
  readyToBook,
  repeatCustomer,
  type RepeatCustomerFacts,
} from '../signals';
import {
  ahead,
  defineDetector,
  detection,
  earliest,
  MINUTE,
  ms,
  stamp,
  valueChips,
  type Assessment,
} from './define';

export interface HotLeadFacts {
  readonly business: BusinessFacts;
  readonly lead: LeadFacts;
  /** When the customer's open conversation began waiting for a reply (`awaiting_reply_since`), or null. */
  readonly awaitingReplySince: string | null;
  /** The customer's own words: their messages still waiting for a reply, and the lead's form message. */
  readonly customerWords: readonly string[];
  readonly repeat: RepeatCustomerFacts;
  /**
   * When someone on the team first reached out once the lead existed (a text, email or chat they sent, a call
   * they made or picked up, a visit); null when nobody has. Only a person's contact settles a hot lead: the AI
   * teammate's or a workflow's reply (which is the lead's first response) takes the edge off instead
   * ("auto-replied": half the urgency, and not urgent). Left out, the first response counts as a person's.
   */
  readonly personContactAt?: string | null;
}

function assess(f: HotLeadFacts, settings: AttentionSettings, now: number): Assessment {
  const { lead, business } = f;
  if (!leadIsOpen(lead) || lead.qualification === 'not_a_fit') return null;
  // Nobody on the team has reached them yet (an import or a lead a person typed in never counts).
  const fresh =
    f.personContactAt === undefined
      ? neverContacted(lead)
      : f.personContactAt === null && !lead.imported && !lead.createdByPerson;
  // HandsFreeOS answered for the business (the AI teammate, a workflow), and they aren't waiting on a reply.
  const autoReplied = fresh && lead.firstResponseAt !== null && !f.awaitingReplySince;
  const clocks = [
    fresh ? ms(lead.createdAt) : null,
    f.awaitingReplySince ? ms(f.awaitingReplySince) : null,
  ].filter((t): t is number => t !== null);
  if (clocks.length === 0) return null;
  const since = Math.min(...clocks);

  const value = leadValue(lead, business, settings);
  const qualified = lead.qualification === 'qualified';
  const ready = f.customerWords.some((w) => readyToBook(w));
  const big = !value.valueIsEstimate && value.value >= settings.hot.minValueCents;
  const repeat = repeatCustomer(f.repeat);
  const today = !lead.imported && cameInToday(lead.createdAt, business.timeZone, now);
  const strong = Number(qualified) + Number(ready);
  const weak = Number(big) + Number(repeat) + Number(today);
  if (strong === 0 && weak < 2) return null;

  const due = since + settings.hot.urgentAfterMinutes * MINUTE;
  // Answered automatically, they aren't left waiting: no urgent section or urgent email, until they write again.
  const urgentFrom = autoReplied ? null : due;
  // "Came in today" stops counting at midnight; look again then if it's one of only two signals.
  const midnight =
    today && strong === 0 && weak === 2 ? nextLocalMidnight(now, business.timeZone) : null;
  return detection({
    fingerprint: fingerprintOf('hot_lead', { lead: lead.id, since: stamp(since) }),
    since,
    urgentFrom,
    dueAt: due,
    value,
    probability: leadProbability({
      stage: lead.stage,
      qualified,
      readyToBook: ready,
      repeatCustomer: repeat,
      notAFit: false,
    }),
    confidence: strong > 0 ? 0.9 : 0.75,
    reasons: [
      ...valueChips(value),
      sinceChip('waiting', since, now),
      ...(ready ? [chip('ready_to_book', 'ready to book')] : []),
      ...(qualified ? [chip('qualified', 'qualified')] : []),
      ...(repeat ? [chip('repeat_customer', 'repeat customer')] : []),
      ...(today ? [chip('came_in_today', 'came in today')] : []),
      ...(autoReplied
        ? [chip('auto_replied', 'auto-replied')]
        : fresh
          ? [chip('not_contacted', 'not contacted yet')]
          : []),
    ],
    assignee: lead.assigneeUserId,
    recheckAt: earliest(ahead(urgentFrom, now), midnight),
  });
}

export const { detect, wakeAt } = defineDetector<HotLeadFacts>('hot_lead', assess);
