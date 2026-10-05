/**
 * An add-on's alert (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md step 5): what an add-on's worker raised in
 * app.addon_alerts for someone to see — a duty running late, a deal at risk. The add-on writes the words, says how
 * serious it is and where it opens; this only puts it on Home and ranks it.
 *
 * - **How serious.** `critical` and `at_risk` are urgent from the moment they're raised; `attention` turns urgent at
 *   its deadline; `info` never does. Seriousness sets the probability, so a critical alert outranks a note.
 * - **Its deadline** counts down ("due in 2 days"), then up ("3 h overdue").
 * - **One that asks to be acknowledged** says so until someone does.
 * - **It goes** when the add-on clears it, and while the add-on isn't running here.
 *
 * The add-on's own fingerprint is part of this one: when the alert says something new, a snoozed card comes back.
 */
import { chip, sinceChip, untilChip } from '../chips';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import type { AttentionChip } from '../types';
import { defineDetector, detection, ms, type Assessment } from './define';

export const ADDON_ALERT_SEVERITIES = ['info', 'attention', 'at_risk', 'critical'] as const;
export type AddonAlertSeverity = (typeof ADDON_ALERT_SEVERITIES)[number];

/** Each severity's word on the card, and how likely it matters (P in the score). */
export const ADDON_ALERT_SEVERITY: Readonly<
  Record<AddonAlertSeverity, { readonly label: string; readonly probability: number }>
> = {
  info: { label: 'For your information', probability: 0.3 },
  attention: { label: 'Needs a look', probability: 0.6 },
  at_risk: { label: 'At risk', probability: 0.85 },
  critical: { label: 'Critical', probability: 0.97 },
};

export interface AddonAlertFacts {
  readonly alert: {
    readonly id: string;
    readonly severity: AddonAlertSeverity;
    readonly raisedAt: string;
    readonly dueAt: string | null;
    readonly needsAck: boolean;
    readonly acknowledgedAt: string | null;
    readonly assigneeUserId: string | null;
    /** What the add-on says it's about, as a digest: a change is news again. */
    readonly fingerprint: string;
    readonly clearedAt: string | null;
  };
  /** Its add-on runs here (enabled, or on its way out with work still to finish). */
  readonly addonRunning: boolean;
}

function assess(f: AddonAlertFacts, _settings: AttentionSettings, now: number): Assessment {
  const a = f.alert;
  if (a.clearedAt || !f.addonRunning) return null;
  const raised = Math.min(ms(a.raisedAt), now);
  const due = a.dueAt ? ms(a.dueAt) : null;
  const serious = a.severity === 'critical' || a.severity === 'at_risk';
  const reasons: AttentionChip[] = [chip('severity', ADDON_ALERT_SEVERITY[a.severity].label)];
  if (a.needsAck && !a.acknowledgedAt) reasons.push(chip('needs_ack', 'Not acknowledged yet'));
  if (due !== null)
    reasons.push(due > now ? untilChip('due_in', due, now) : sinceChip('overdue', due, now));
  return detection({
    fingerprint: fingerprintOf('addon_alert', {
      alert: a.id,
      severity: a.severity,
      said: a.fingerprint,
    }),
    since: raised,
    urgentFrom: serious ? raised : a.severity === 'attention' ? due : null,
    dueAt: due,
    // It's about the business's work, not money: shown without dollars and left out of "$ affected".
    value: { value: 0, valueIsEstimate: true, moneyKey: null },
    probability: ADDON_ALERT_SEVERITY[a.severity].probability,
    confidence: 0.95,
    reasons,
    assignee: a.assigneeUserId,
    // Its deadline passing turns the countdown into "overdue" (and an `attention` alert urgent).
    recheckAt: due !== null && due > now ? due : null,
  });
}

export const { detect, wakeAt } = defineDetector<AddonAlertFacts>('addon_alert', assess);
