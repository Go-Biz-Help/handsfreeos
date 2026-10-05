/**
 * An add-on's alert on Home (Real Estate step 5), without a database: how serious it says it is decides whether it's
 * urgent and how it ranks, its deadline counts down and then up, one that asks to be acknowledged says so until
 * someone does, and it goes when the add-on clears it or stops running. Its card opens the add-on's own page.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDON_ALERT_SEVERITIES,
  attentionTargetOf,
  chipText,
  defaultAttentionSettings,
  DETECTORS,
  handleButtonOf,
  letHandleModeOf,
  mayTakeAttentionAction,
  type AddonAlertFacts,
} from '../src/attention/index';
import { rankItems, scoreOf } from '../src/attention/score';
import { DAY, HOUR, NOW, ago, later, uid } from './attention-fixtures';

const settings = defaultAttentionSettings();
const d = DETECTORS.addon_alert;
const facts = (
  over: Partial<AddonAlertFacts['alert']> = {},
  addonRunning = true,
): AddonAlertFacts => ({
  alert: {
    id: uid(7),
    severity: 'attention',
    raisedAt: ago(2 * HOUR),
    dueAt: null,
    needsAck: false,
    acknowledgedAt: null,
    assigneeUserId: null,
    fingerprint: 'duty:12:overdue',
    clearedAt: null,
    ...over,
  },
  addonRunning,
});

describe('addon_alert', () => {
  it('is urgent at once when critical or at risk, at its deadline when it needs a look, never when it’s a note', () => {
    const critical = d.detect(facts({ severity: 'critical' }), settings, NOW)!;
    expect(critical.urgentFrom).toBe(ago(2 * HOUR));
    expect(d.detect(facts({ severity: 'at_risk' }), settings, NOW)!.urgentFrom).toBe(ago(2 * HOUR));
    expect(d.detect(facts({ dueAt: later(DAY) }), settings, NOW)!.urgentFrom).toBe(later(DAY));
    expect(d.detect(facts({ severity: 'info', dueAt: ago(DAY) }), settings, NOW)!.urgentFrom).toBe(
      null,
    );
    // No money in it: shown without dollars and left out of "$ affected".
    expect(critical).toMatchObject({ value: 0, valueIsEstimate: true, moneyKey: null });
  });

  it('ranks by how serious it is', () => {
    const scored = ADDON_ALERT_SEVERITIES.map((severity) => {
      const found = d.detect(facts({ severity, raisedAt: ago(HOUR) }), settings, NOW)!;
      return {
        id: severity,
        kind: 'addon_alert' as const,
        value: found.value,
        probability: found.probability,
        confidence: found.confidence,
        since: found.since,
        dueAt: found.dueAt,
        urgentFrom: found.urgentFrom,
        reasons: found.reasons,
      };
    });
    expect(rankItems(scored, NOW.getTime()).map((s) => s.id)).toEqual([
      'critical',
      'at_risk',
      'attention',
      'info',
    ]);
    expect(scoreOf(scored[3]!, NOW.getTime())).toBeGreaterThan(0);
  });

  it('counts its deadline down, then up, and looks again when it passes', () => {
    const ahead = d.detect(facts({ dueAt: later(2 * DAY) }), settings, NOW)!;
    const due = ahead.reasons.find((c) => c.code === 'due_in')!;
    expect(chipText(due, NOW)).toBe('due in 2 days');
    expect(ahead.recheckAt).toBe(later(2 * DAY));
    const past = d.detect(facts({ dueAt: ago(3 * HOUR) }), settings, NOW)!;
    expect(
      chipText(
        past.reasons.find((c) => c.code === 'overdue')!,
        NOW,
      ),
    ).toBe('3 h overdue');
    expect(past.recheckAt).toBeNull();
  });

  it('asks to be acknowledged until someone does, without coming back as news', () => {
    const asks = d.detect(facts({ severity: 'at_risk', needsAck: true }), settings, NOW)!;
    expect(asks.reasons.map((c) => c.code)).toEqual(['severity', 'needs_ack']);
    expect(asks.reasons[0]!.label).toBe('At risk');
    const seen = d.detect(
      facts({ severity: 'at_risk', needsAck: true, acknowledgedAt: ago(HOUR) }),
      settings,
      NOW,
    )!;
    expect(seen.reasons.map((c) => c.code)).toEqual(['severity']);
    expect(seen.fingerprint).toBe(asks.fingerprint);
    // Saying something new is news: a snoozed card comes back.
    expect(
      d.detect(facts({ severity: 'critical', needsAck: true }), settings, NOW)!.fingerprint,
    ).not.toBe(asks.fingerprint);
    expect(
      d.detect(facts({ fingerprint: 'duty:12:at_risk' }), settings, NOW)!.fingerprint,
    ).not.toBe(d.detect(facts(), settings, NOW)!.fingerprint);
  });

  it('goes when the add-on clears it, or stops running here', () => {
    expect(d.detect(facts({ clearedAt: ago(HOUR) }), settings, NOW)).toBeNull();
    expect(d.detect(facts({}, false), settings, NOW)).toBeNull();
  });

  it('follows whoever the add-on says it’s for', () => {
    expect(d.detect(facts({ assigneeUserId: uid(31) }), settings, NOW)!.assignee).toBe(uid(31));
  });

  it('opens the add-on’s own page, and is never handed off, assigned or dismissed from Home', () => {
    const item = {
      kind: 'addon_alert' as const,
      subject: { type: 'addon_alert', id: uid(7) },
      leadId: null,
      conversationId: null,
      appointmentId: null,
      reasons: [],
      personId: null,
      addonAlert: {
        alertId: uid(7),
        addonId: 'realestate',
        addonName: 'Real Estate Agent',
        severity: 'at_risk' as const,
        href: '/a/realestate/deals/abc',
        needsAck: true,
        acknowledgedAt: null,
      },
    };
    expect(attentionTargetOf(item, uid(8))).toEqual({
      href: `/app/w/${uid(8)}/a/realestate/deals/abc`,
      label: 'Open in Real Estate Agent',
    });
    expect(
      handleButtonOf(
        { ...item, title: 'Inspection response due', reach: null, callable: false },
        false,
      ),
    ).toEqual({ label: 'Open', icon: 'file-text' });
    expect(letHandleModeOf('addon_alert')).toBe('none');
    const owner = { role: 'owner' as const, permissions: null };
    expect(mayTakeAttentionAction(owner, 'addon_alert', 'handle')).toBe(true);
    expect(mayTakeAttentionAction(owner, 'addon_alert', 'snooze')).toBe(true);
    expect(mayTakeAttentionAction(owner, 'addon_alert', 'assign')).toBe(false);
    expect(mayTakeAttentionAction(owner, 'addon_alert', 'dismiss')).toBe(false);
  });
});
