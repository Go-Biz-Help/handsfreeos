/**
 * Hot after a webinar (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 5): someone scored Hot after a HandsFreeOS
 * video call with a live poll, whom a person should reach. Either the poll puts its hot ones on Home, or it has the AI
 * teammate text them and that couldn't happen (there's no AI teammate, it's off, or someone on the team has their
 * conversation).
 *
 * It holds while nobody has written to them or called them since they were scored, for three days: interest from a
 * webinar cools fast, and a week later the card would only be noise.
 */
import { chip, sinceChip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

/** How long the card asks someone to reach them (meetings/leads.ts says the same). */
export const WEBINAR_HOT_DAYS = 3;

export interface WebinarHotFacts {
  readonly business: BusinessFacts;
  readonly lead: {
    readonly id: string;
    readonly label: 'hot' | 'warm' | 'cold';
    /** What the poll said to do with the hot ones: only `home` opens a card on its own. */
    readonly followUp: 'list' | 'home' | 'text';
    /** What became of the AI teammate's text: `card` asks a person. */
    readonly outcome: 'sent' | 'drafted' | 'card' | 'skipped' | null;
    readonly scoredAt: string;
    readonly points: number;
    /** "Roofing webinar": the appointment's title, or the poll's name. */
    readonly what: string;
    /** The latest message or call to them since they were scored, or null. */
    readonly contactedAt: string | null;
    readonly personArchived: boolean;
  };
  readonly openLead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
}

function assess(f: WebinarHotFacts, settings: AttentionSettings, now: number): Assessment {
  const l = f.lead;
  if (l.label !== 'hot' || l.personArchived || l.contactedAt) return null;
  if (l.followUp !== 'home' && l.outcome !== 'card') return null;
  const since = ms(l.scoredAt);
  const until = since + WEBINAR_HOT_DAYS * DAY;
  if (now >= until) return null;
  return detection({
    fingerprint: fingerprintOf('webinar_hot', { lead: l.id }),
    since,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(f.openLead, f.business, settings),
    probability: 0.6,
    confidence: 0.8,
    reasons: [
      chip('webinar', `${l.what} · ${l.points === 1 ? '1 point' : `${l.points} points`}`),
      sinceChip('waiting', since, now),
    ],
    assignee: f.assigneeUserId,
    // Look again when the offer runs out.
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<WebinarHotFacts>('webinar_hot', assess);
