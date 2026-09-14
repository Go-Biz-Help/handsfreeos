import { describe, expect, it } from 'vitest';
import {
  applyTeammatePatch,
  diffTeammateConfigs,
  emptyTeammateConfig,
  formatTeammateLabels,
  inferTeammateLabels,
  notifyText,
  teammateConfigFromPreset,
  type TeammatePatch,
  type TeammatePresetKey,
} from '../src/ai-team/index';
import {
  catalogs,
  DALE,
  HELLO,
  OFFICE,
  presetContext,
  PRIYA,
  SERVICE_CAL,
  STAGE_QUALIFIED,
} from './ai-team-fixtures';

const labelOf = (key: TeammatePresetKey, patch: TeammatePatch = {}) =>
  formatTeammateLabels(
    inferTeammateLabels(applyTeammatePatch(teammateConfigFromPreset(key, presetContext), patch)),
  );

describe('labels', () => {
  it('name each preset', () => {
    expect(labelOf('lead_responder')).toBe('Lead Responder · Follows up');
    expect(labelOf('lead_qualifier')).toBe('Lead Qualifier · Follows up');
    expect(labelOf('appointment_coordinator')).toBe('Appointment Coordinator');
    expect(labelOf('blank')).toBe('Lead Responder');
  });

  it('read like the plan: “Lead Responder · Books appointments”', () => {
    expect(labelOf('blank', { book: { enabled: true, calendarIds: [SERVICE_CAL] } })).toBe(
      'Lead Responder · Books appointments',
    );
  });

  it('follow the skills as they switch', () => {
    expect(labelOf('appointment_coordinator', { qualify: { enabled: true } })).toBe(
      'Lead Qualifier · Books appointments',
    );
    expect(labelOf('lead_responder', { respond: { newLeads: { enabled: false } } })).toBe(
      'Answers questions · Follows up',
    );
    expect(
      labelOf('blank', {
        respond: { enabled: false },
        answer: { enabled: false },
      }),
    ).toBe('Custom');
    expect(inferTeammateLabels(emptyTeammateConfig())).toEqual({
      primary: 'lead_responder',
      tags: ['lead_responder'],
    });
  });
});

describe('diff', () => {
  it('is empty when nothing changed', () => {
    const c = teammateConfigFromPreset('lead_responder', presetContext);
    expect(diffTeammateConfigs(c, applyTeammatePatch(c, {}), catalogs)).toEqual([]);
  });

  it('describes identity, channels and skills by name', () => {
    const a = teammateConfigFromPreset('lead_responder', presetContext);
    const b = applyTeammatePatch(a, {
      identity: { name: 'Max', disclosure: 'when_asked', signature: '– Max' },
      channels: { chat: false, emailAddressId: OFFICE },
      respond: { newLeads: { channel: 'email', delayMinutes: 0 } },
      answer: { whenUnsure: 'take_message' },
      book: { enabled: true, calendarIds: [SERVICE_CAL] },
    });
    expect(diffTeammateConfigs(a, b, catalogs)).toEqual([
      'Name: Ava → Max',
      'Says it’s AI: in its first message → when asked',
      'Signature changed',
      'Website chat: on → off',
      'Emails from: hello@lonestarhvac.com → office@lonestarhvac.com',
      'First message by: text → email',
      'Waits before the first message: 1 minute → no wait',
      'When unsure: hands to a person → takes a message',
      'Books appointments: off → on',
      'Added the calendar Service calls',
    ]);
  });

  it('describes questions, hours, autonomy, limits, money and hand-offs', () => {
    const a = teammateConfigFromPreset('lead_qualifier', presetContext);
    const [need, timeline] = a.qualify.questions;
    const b = applyTeammatePatch(a, {
      qualify: {
        questions: [
          timeline!,
          { ...need!, required: false },
          {
            id: 'budget',
            question: 'What’s your budget?',
            kind: 'number',
            notAFitIf: { below: 1000 },
          },
        ],
        whenQualified: {
          stageId: STAGE_QUALIFIED,
          notify: { kind: 'users', userIds: [DALE, PRIYA] },
        },
      },
      hours: { mode: 'custom', custom: [{ day: 1, start: '08:00', end: '18:00' }] },
      autonomy: { approvalsNeeded: 10 },
      limits: { dailySharePercent: 40 },
      money: { discounts: 'with_approval', maxPercent: 15 },
      handOff: {
        onFrustration: false,
        sensitiveTopics: ['insurance claims'],
        notify: { kind: 'lead_assignee' },
      },
    });
    expect(diffTeammateConfigs(a, b, catalogs)).toEqual([
      'Changed the question “What do you need help with?”',
      'Added the question “What’s your budget?”',
      'Removed the question “Do you own the home?”',
      'Removed the question “What ZIP code is the job in?”',
      'Question order changed',
      'Qualified leads move to: stay where they are → Qualified',
      'Who hears about qualified leads: no one → Dale and Priya',
      'Works: all the time → set hours',
      'Hours: Mon–Fri 9:00 AM–5:00 PM → Mon 8:00 AM–6:00 PM',
      'Approvals before automatic: 20 → 10',
      'Share of the daily AI limit: 60% → 40%',
      'Discounts: never → with approval',
      'Largest discount: 10% → 15%',
      'Hands off when frustrated: on → off',
      'Added the topic “insurance claims”',
      'Who hears about hand-offs: owners and admins → the lead’s assignee',
    ]);
  });

  it('works without names', () => {
    const a = emptyTeammateConfig();
    const b = applyTeammatePatch(a, {
      channels: { emailAddressId: HELLO },
      book: { enabled: true, calendarIds: [SERVICE_CAL] },
      handOff: { notify: { kind: 'users', userIds: [DALE] } },
    });
    expect(diffTeammateConfigs(a, b)).toEqual([
      'Emails from: none → an address',
      'Books appointments: off → on',
      'Added a calendar',
      'Who hears about hand-offs: owners and admins → someone',
    ]);
    expect(diffTeammateConfigs(b, a)).toContain('Removed a calendar');
  });

  it('names who is told', () => {
    expect(notifyText(null)).toBe('no one');
    expect(notifyText({ kind: 'person_owner' })).toBe('the customer’s owner');
    expect(notifyText({ kind: 'users', userIds: [DALE, PRIYA, { $ph: 'x' }] }, catalogs)).toBe(
      'Dale, Priya and someone',
    );
  });
});
