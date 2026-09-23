/**
 * Maintenance due (Automations' "Maintenance due"): a customer's regular service came round, HandsFreeOS texted
 * them twice, and they haven't booked. A person is asked to call them.
 *
 * It holds until they book the service, somebody gets in touch with them (a message or a call), or thirty days
 * pass.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

export const MAINTENANCE_CARD_DAYS = 30;

export interface MaintenanceDueFacts {
  readonly business: BusinessFacts;
  readonly reminder: {
    readonly id: string;
    readonly status: 'reminding' | 'booked' | 'card' | 'stopped';
    /** When the texts ran out and a person was asked. */
    readonly cardAt: string | null;
    /** "AC tune-up due Oct 5": the service, and when. */
    readonly label: string;
    /** They booked the service since. */
    readonly booked: boolean;
    /** The latest message or call to them since the card opened, or null. */
    readonly contactedAt: string | null;
  };
  readonly lead: LinkedLeadFacts | null;
  readonly assigneeUserId: string | null;
}

function assess(f: MaintenanceDueFacts, settings: AttentionSettings, now: number): Assessment {
  const r = f.reminder;
  if (r.status !== 'card' || !r.cardAt || r.booked || r.contactedAt) return null;
  const since = ms(r.cardAt);
  const until = since + MAINTENANCE_CARD_DAYS * DAY;
  if (now >= until) return null;
  const value = leadValue(f.lead, f.business, settings);
  return detection({
    fingerprint: fingerprintOf('maintenance_due', { reminder: r.id }),
    since,
    urgentFrom: null,
    dueAt: null,
    value,
    probability: 0.5,
    confidence: 0.7,
    reasons: [chip('maintenance', r.label)],
    assignee: f.assigneeUserId,
    recheckAt: until,
  });
}

export const { detect, wakeAt } = defineDetector<MaintenanceDueFacts>('maintenance_due', assess);
