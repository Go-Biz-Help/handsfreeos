import { describe, expect, it } from 'vitest';
import {
  ATTENTION_ACTIONS,
  ATTENTION_HANDLE_LABELS,
  ATTENTION_KIND_LABELS,
  ATTENTION_KIND_PLURALS,
  ATTENTION_KINDS,
  ATTENTION_PERMISSIONS,
  ATTENTION_SUBJECT_OF,
  attentionSettingsOf,
  AUTO_KINDS,
  autoActionOf,
  DEFAULT_NUDGE_TEMPLATE,
  defaultAttentionSettings,
  isLeadKind,
  LEAD_PRECEDENCE,
  LET_HANDLE_REFUSALS,
  letHandleModeOf,
  letHandleRefusal,
  mayTakeAttentionAction,
  nudgesOn,
  parseAttentionSettings,
  readAttentionSettings,
  staleDaysFor,
  typicalJobValueCents,
  type AttentionKind,
} from '../src/attention/index';
import { ROLE_PERMISSIONS, WORKSPACE_ROLES } from '../src/permissions';
import { uid } from './attention-fixtures';

describe('attention kinds', () => {
  it('lists the thirty-two kinds in order', () => {
    expect(ATTENTION_KINDS).toEqual([
      'hot_lead',
      'unanswered_lead',
      'stale_opportunity',
      'missing_next_action',
      'unconfirmed_appointment',
      'ai_approval',
      'customer_waiting',
      'overdue_task',
      'estimate_waiting',
      'invoice_overdue',
      'wallet_low',
      'wallet_empty',
      'wallet_card_declined',
      'job_not_thanked',
      'referral_mentioned',
      'maintenance_due',
      'pipeline_mismatch',
      'quiet_after_price',
      'job_unconfirmed',
      'job_never_completed',
      'job_no_address',
      'client_quiet',
      'promise_due',
      'revenue_moved',
      'channel_quiet',
      'connection_error',
      'connection_silent',
      'ai_unreviewed',
      'ai_corrections',
      'website_changed',
      'faq_suggestions',
      'offer_lapsing',
    ]);
  });

  it('names every kind, its subject and its main button', () => {
    for (const kind of ATTENTION_KINDS) {
      expect(ATTENTION_KIND_LABELS[kind]).toBeTruthy();
      expect(ATTENTION_KIND_PLURALS[kind]).toBeTruthy();
      expect(ATTENTION_HANDLE_LABELS[kind]).toBeTruthy();
      expect(ATTENTION_SUBJECT_OF[kind]).toMatch(/^[a-z][a-z_]{0,39}$/);
    }
  });

  it('puts one card on a lead: hot, unanswered, quiet after a price, stale, then missing next action', () => {
    expect(LEAD_PRECEDENCE).toEqual([
      'hot_lead',
      'unanswered_lead',
      'quiet_after_price',
      'stale_opportunity',
      'missing_next_action',
    ]);
    expect([...ATTENTION_KINDS.filter(isLeadKind)].sort()).toEqual([...LEAD_PRECEDENCE].sort());
  });

  it('asks only for permissions that exist', () => {
    const known = new Set<string>(Object.values(ROLE_PERMISSIONS).flat());
    for (const kind of ATTENTION_KINDS)
      for (const action of ATTENTION_ACTIONS)
        for (const p of ATTENTION_PERMISSIONS[kind][action] ?? []) expect(known).toContain(p);
  });

  it('needs records.write for everything that changes the item, as row-level security does', () => {
    for (const kind of ATTENTION_KINDS)
      for (const action of ATTENTION_ACTIONS) {
        const needed = ATTENTION_PERMISSIONS[kind][action];
        if (needed === null || (kind === 'ai_approval' && action === 'handle')) continue;
        expect(needed, `${kind}.${action}`).toContain('records.write');
      }
    // Deciding an approval is checked on the approval itself.
    expect(ATTENTION_PERMISSIONS.ai_approval.handle).toEqual(['workspace.read']);
  });

  it('lets every role act, but never hands off an AI approval or an overdue task', () => {
    // Money is the exception: chasing it needs money.manage, which a member doesn't have. The wallet's three
    // are the same — a member sees that the business is running out and cannot spend its money.
    const money: AttentionKind[] = [
      'estimate_waiting',
      'invoice_overdue',
      'wallet_low',
      'wallet_empty',
      'wallet_card_declined',
      // The business's week of money: only people who manage it open it.
      'revenue_moved',
      // What the AI knows is changed by people who manage it (knowledge.manage), like any knowledge edit.
      'ai_corrections',
      'website_changed',
      'faq_suggestions',
      // Extending an offer is a knowledge edit too.
      'offer_lapsing',
    ];
    for (const role of WORKSPACE_ROLES)
      for (const kind of ATTENTION_KINDS)
        for (const action of ATTENTION_ACTIONS) {
          if (money.includes(kind) && (action === 'handle' || action === 'let_handle')) continue;
          expect(mayTakeAttentionAction({ role }, kind, action), `${role} ${kind}.${action}`).toBe(
            ATTENTION_PERMISSIONS[kind][action] !== null,
          );
        }
    expect(ATTENTION_PERMISSIONS.ai_approval.let_handle).toBeNull();
    expect(ATTENTION_PERMISSIONS.overdue_task.let_handle).toBeNull();
    expect(mayTakeAttentionAction({ role: null }, 'hot_lead', 'snooze')).toBe(false);
  });

  it('shows a member the money cards but never the button that chases someone', () => {
    for (const kind of ['estimate_waiting', 'invoice_overdue'] as AttentionKind[]) {
      expect(ATTENTION_PERMISSIONS[kind].handle).toEqual(['records.write', 'money.manage']);
      for (const role of ['owner', 'admin'] as const)
        expect(mayTakeAttentionAction({ role }, kind, 'handle')).toBe(true);
      expect(mayTakeAttentionAction({ role: 'member' }, kind, 'handle')).toBe(false);
      expect(mayTakeAttentionAction({ role: 'member' }, kind, 'let_handle')).toBe(false);
      // They can still pass it on, put it off or let it go.
      for (const action of ['assign', 'snooze', 'dismiss'] as const)
        expect(mayTakeAttentionAction({ role: 'member' }, kind, action)).toBe(true);
    }
  });

  it('runs only confirmation requests and follow-up nudges on their own', () => {
    expect(AUTO_KINDS).toEqual({
      unconfirmed_appointment: 'confirm_request',
      stale_opportunity: 'nudge',
      missing_next_action: 'nudge',
    });
    expect(autoActionOf('unconfirmed_appointment')).toBe('confirm_request');
    expect(autoActionOf('stale_opportunity')).toBe('nudge');
    // A missing next action is automatic only as an overdue follow-up.
    expect(autoActionOf('missing_next_action')).toBeNull();
    expect(autoActionOf('missing_next_action', [{ code: 'follow_up_overdue' }])).toBe('nudge');
    const askFirst: AttentionKind[] = [
      'hot_lead',
      'unanswered_lead',
      'ai_approval',
      'customer_waiting',
      'overdue_task',
      // Money never chases itself.
      'estimate_waiting',
      'invoice_overdue',
    ];
    for (const kind of askFirst) expect(autoActionOf(kind)).toBeNull();
  });

  it('says what Let HandsFreeOS Handle does for each kind', () => {
    expect(letHandleModeOf('unconfirmed_appointment')).toBe('auto');
    expect(letHandleModeOf('stale_opportunity')).toBe('auto');
    expect(letHandleModeOf('missing_next_action', [{ code: 'follow_up_overdue' }])).toBe('auto');
    expect(letHandleModeOf('missing_next_action')).toBe('ask');
    expect(letHandleModeOf('hot_lead')).toBe('ask');
    expect(letHandleModeOf('unanswered_lead')).toBe('ask');
    expect(letHandleModeOf('customer_waiting')).toBe('ask');
    expect(letHandleModeOf('ai_approval')).toBe('none');
    expect(letHandleModeOf('overdue_task')).toBe('none');
    // Money asks first: it writes the follow-up and waits for a person to send it.
    expect(letHandleModeOf('estimate_waiting')).toBe('ask');
    expect(letHandleModeOf('invoice_overdue')).toBe('ask');
  });

  it('refuses the kinds HandsFreeOS never handles in a sentence a person can read', () => {
    for (const kind of ATTENTION_KINDS) {
      const refusal = letHandleRefusal(kind);
      expect(refusal === null, kind).toBe(letHandleModeOf(kind, [{ code: 'x' }]) !== 'none');
      if (refusal) expect(refusal, kind).toMatch(/^[A-Z].*\.$/);
    }
    // Only the kinds nobody can hand off are refused; every other kind has something to offer.
    expect(Object.keys(LET_HANDLE_REFUSALS).sort()).toEqual([
      'ai_approval',
      'ai_corrections',
      'ai_unreviewed',
      'channel_quiet',
      'client_quiet',
      'connection_error',
      'connection_silent',
      'faq_suggestions',
      'job_never_completed',
      'job_no_address',
      'job_not_thanked',
      'job_unconfirmed',
      'maintenance_due',
      'offer_lapsing',
      'overdue_task',
      'pipeline_mismatch',
      'promise_due',
      'quiet_after_price',
      'referral_mentioned',
      'revenue_moved',
      'wallet_card_declined',
      'wallet_empty',
      'wallet_low',
      'website_changed',
    ]);
    expect(letHandleRefusal('hot_lead')).toBeNull();
    expect(letHandleRefusal('invoice_overdue')).toBeNull();
  });
});

describe('attention settings', () => {
  it('starts from the defaults Chris approves', () => {
    const s = defaultAttentionSettings();
    expect(Object.keys(s.kinds)).toEqual([...ATTENTION_KINDS]);
    expect(Object.values(s.kinds).every(Boolean)).toBe(true);
    expect(s.hot).toEqual({ minValueCents: 500_000, urgentAfterMinutes: 10 });
    expect(s.unanswered).toEqual({ afterOpenMinutes: 15 });
    expect(s.stale).toEqual({ days: 7, stageDays: {} });
    expect(s.appointments).toEqual({ windowHours: 48 });
    expect(s.money).toEqual({
      estimateWaitingDays: 5,
      invoiceOverdueDays: 1,
      minBalanceCents: 0,
    });
    expect(s.typicalJobValueCents).toBeNull();
    expect(s.auto).toEqual({ confirmRequests: true, nudges: false, nudgeReviewedAt: null });
    expect(s.nudge).toEqual({ template: DEFAULT_NUDGE_TEMPLATE, cooldownDays: 14 });
    expect(s.replyToConfirm).toBe(true);
  });

  it('reads a business with no Action Center settings as the defaults', () => {
    expect(attentionSettingsOf(null)).toEqual(defaultAttentionSettings());
    expect(attentionSettingsOf({ openHours: [], website: 'https://x.com' })).toEqual(
      defaultAttentionSettings(),
    );
    expect(readAttentionSettings('nonsense')).toEqual(defaultAttentionSettings());
    expect(readAttentionSettings([1, 2])).toEqual(defaultAttentionSettings());
  });

  it('keeps what partial settings say and fills in the rest', () => {
    const s = attentionSettingsOf({
      attention: { stale: { days: 10 }, kinds: { overdue_task: false } },
    });
    expect(s.stale.days).toBe(10);
    expect(s.kinds.overdue_task).toBe(false);
    expect(s.kinds.hot_lead).toBe(true);
    expect(s.hot.urgentAfterMinutes).toBe(10);
  });

  it('falls back field by field when stored settings are unreadable', () => {
    const s = readAttentionSettings({
      hot: { minValueCents: 'lots', urgentAfterMinutes: 20 },
      stale: { days: 0 },
      unanswered: 'soon',
      nudge: { template: 'Hi {name}!', cooldownDays: 21 },
      legacy: true,
    });
    expect(s.hot).toEqual({ minValueCents: 500_000, urgentAfterMinutes: 20 });
    expect(s.stale.days).toBe(7);
    expect(s.unanswered.afterOpenMinutes).toBe(15);
    expect(s.nudge).toEqual({ template: DEFAULT_NUDGE_TEMPLATE, cooldownDays: 21 });
    expect('legacy' in s).toBe(false);
  });

  it('keeps nudges off until an owner has reviewed the message', () => {
    expect(readAttentionSettings({ auto: { nudges: true } }).auto.nudges).toBe(false);
    expect(nudgesOn(defaultAttentionSettings())).toBe(false);
    const reviewed = readAttentionSettings({
      auto: { nudges: true, nudgeReviewedAt: '2026-09-15T15:00:00.000Z' },
    });
    expect(nudgesOn(reviewed)).toBe(true);
    expect(
      nudgesOn(readAttentionSettings({ auto: { nudgeReviewedAt: '2026-09-15T15:00:00.000Z' } })),
    ).toBe(false);
  });

  it('explains what can’t be saved', () => {
    expect(() => parseAttentionSettings({ auto: { nudges: true } })).toThrow(/Looks good, turn on/);
    expect(() => parseAttentionSettings({ nudge: { template: 'Hi {name}' } })).toThrow(
      /\{name\} can’t be filled in/,
    );
    expect(() => parseAttentionSettings({ nudge: { template: '   ' } })).toThrow(
      /Write the follow-up message/,
    );
    expect(() => parseAttentionSettings({ stale: { days: 0 } })).toThrow(/At least 1 day/);
    expect(() => parseAttentionSettings({ hot: { urgentAfterMinutes: 999 } })).toThrow(
      /At most 4 hours/,
    );
    expect(parseAttentionSettings(undefined)).toEqual(defaultAttentionSettings());
  });

  it('gives a stage its own stale days', () => {
    const quoted = uid(102);
    const s = parseAttentionSettings({ stale: { days: 7, stageDays: { [quoted]: 3 } } });
    expect(staleDaysFor(s, quoted)).toBe(3);
    expect(staleDaysFor(s, uid(103))).toBe(7);
    expect(staleDaysFor(s, null)).toBe(7);
    expect(
      readAttentionSettings({ stale: { days: 5, stageDays: { 'not-a-stage': 3 } } }).stale,
    ).toEqual({ days: 5, stageDays: {} });
  });

  it('works out the typical job value: the business’s own, else the median won lead, else $500', () => {
    const s = defaultAttentionSettings();
    expect(typicalJobValueCents(s, null)).toBe(50_000);
    expect(typicalJobValueCents(s, 0)).toBe(50_000);
    expect(typicalJobValueCents(s, 425_000)).toBe(425_000);
    const own = parseAttentionSettings({ typicalJobValueCents: 90_000 });
    expect(typicalJobValueCents(own, 425_000)).toBe(90_000);
  });
});
