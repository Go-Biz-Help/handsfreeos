import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import * as core from '../src/index';
import {
  applyTeammatePatch,
  DEFAULT_FOLLOW_UP_LADDER,
  followUpDueAt,
  followUpLadderWords,
  followUpScheduleMinutes,
  type FollowUpStep,
  emptyTeammateConfig,
  inferTeammateLabels,
  parseTeammateConfig,
  qualificationOf,
  suggestedQuestions,
  TEAMMATE_CONFIG_VERSION,
  TEAMMATE_PRESET_KEYS,
  TEAMMATE_PRESETS,
  TeammateConfig,
  teammateConfigFromPreset,
  TeammateConfigVersionError,
  upgradeTeammateConfig,
  type TeammatePatch,
} from '../src/ai-team/index';
import {
  DALE,
  HELLO,
  OFFICE,
  presetContext,
  PRIYA,
  SERVICE_CAL,
  STAGE_QUALIFIED,
  WIDGET,
} from './ai-team-fixtures';

describe('defaults', () => {
  it('fills every module with the plan’s defaults', () => {
    const c = emptyTeammateConfig();
    expect(c.version).toBe(3);
    expect(c.identity).toEqual({
      name: 'Ava',
      disclosure: 'first_message',
      signature: '',
      toneNote: '',
    });
    expect(c.channels).toEqual({
      sms: true,
      email: true,
      chat: false,
      emailAddressId: null,
      widgetId: null,
    });
    expect(c.respond).toEqual({
      enabled: true,
      newLeads: { enabled: true, channel: 'sms', delayMinutes: 1 },
    });
    expect(c.answer).toEqual({ enabled: true, whenUnsure: 'hand_off' });
    expect(c.qualify).toEqual({
      enabled: false,
      questions: [],
      whenQualified: { stageId: null, notify: null, offerTimes: true },
      whenNotAFit: { tellTeam: true },
    });
    expect(c.book).toEqual({
      enabled: false,
      calendarIds: [],
      reschedule: true,
      cancel: true,
      waitlist: true,
      repeats: false,
      serviceArea: true,
    });
    expect(c.deals).toEqual({ enabled: false });
    expect(c.followUp).toEqual({
      enabled: true,
      neverReplied: true,
      chaseTimes: true,
      ladder: [
        { after: 4, unit: 'hours' },
        { after: 1, unit: 'days' },
        { after: 2, unit: 'days' },
        { after: 4, unit: 'days' },
        { after: 7, unit: 'days' },
        { after: 10, unit: 'days' },
        { after: 14, unit: 'days' },
        { after: 21, unit: 'days' },
        { after: 30, unit: 'days' },
      ],
      monthlyForMonths: 6,
    });
    expect(c.hours).toEqual({
      mode: 'always',
      custom: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
    });
    expect(c.autonomy).toEqual({ approvalsNeeded: 20, draftExpiresMinutes: 120 });
    expect(c.limits).toEqual({
      repliesPerConversationPerDay: 12,
      toolRounds: 6,
      dailySharePercent: 60,
    });
    expect(c.money).toEqual({
      discounts: 'never',
      maxPercent: 10,
      bills: false,
      newBills: false,
      quotes: 'off',
      plans: false,
    });
    expect(c.handOff).toEqual({
      onFrustration: true,
      sensitiveTopics: [],
      notify: { kind: 'admins' },
      // Email stays on for a document saved before M18; new teammates start with it off.
      alerts: { push: true, text: true, email: true },
      tellCustomer: "Thanks for your patience. I've passed this to our team, and {expectation}.",
    });
  });

  it('never shares default lists between documents', () => {
    const a = emptyTeammateConfig();
    a.book.calendarIds.push(SERVICE_CAL);
    a.hours.custom.push({ day: 6, start: '09:00', end: '12:00' });
    a.handOff.sensitiveTopics.push('insurance');
    const b = emptyTeammateConfig();
    expect(b.book.calendarIds).toEqual([]);
    expect(b.hours.custom).toHaveLength(5);
    expect(b.handOff.sensitiveTopics).toEqual([]);
  });

  it('keeps the status and the training counts out of the document', () => {
    expect(Object.keys(emptyTeammateConfig()).sort()).toEqual([
      'answer',
      'autonomy',
      'book',
      'channels',
      'deals',
      'followUp',
      'handOff',
      'hours',
      'identity',
      'limits',
      'money',
      'phone',
      'photos',
      'qualify',
      'respond',
      'version',
    ]);
  });

  it('is exported from the core entry the web imports', () => {
    const names = [
      'parseTeammateConfig',
      'teammateConfigFromPreset',
      'validateTeammate',
      'inferTeammateLabels',
      'diffTeammateConfigs',
      'checkTeammateReply',
      'teammateTools',
    ] as const;
    for (const name of names) expect(typeof core[name], name).toBe('function');
  });
});

describe('parse and upgrade', () => {
  it('reads a stored document, filling what is missing and dropping unknown keys', () => {
    const c = parseTeammateConfig({ version: 1, identity: { name: 'Max' }, legacy: true });
    expect(c.identity).toEqual({
      name: 'Max',
      disclosure: 'first_message',
      signature: '',
      toneNote: '',
    });
    expect('legacy' in c).toBe(false);
  });

  it('reads a version 1 document saved before “Then offer times” and “Tell the team”, with both on', () => {
    const c = parseTeammateConfig({
      version: 1,
      qualify: { enabled: true, whenQualified: { stageId: STAGE_QUALIFIED, notify: null } },
    });
    expect(c.qualify.whenQualified).toEqual({
      stageId: STAGE_QUALIFIED,
      notify: null,
      offerTimes: true,
    });
    expect(c.qualify.whenNotAFit).toEqual({ tellTeam: true });
    const off = applyTeammatePatch(c, {
      qualify: { whenQualified: { offerTimes: false }, whenNotAFit: { tellTeam: false } },
    });
    expect([off.qualify.whenQualified.offerTimes, off.qualify.whenNotAFit.tellTeam]).toEqual([
      false,
      false,
    ]);
    expect(off.qualify.whenQualified.stageId).toBe(STAGE_QUALIFIED);
  });

  it('treats a document without a version as version 1', () => {
    expect(parseTeammateConfig({}).version).toBe(TEAMMATE_CONFIG_VERSION);
    expect(parseTeammateConfig(null)).toEqual(emptyTeammateConfig());
  });

  it('refuses a document from a newer app', () => {
    expect(() => parseTeammateConfig({ version: TEAMMATE_CONFIG_VERSION + 1 })).toThrow(
      TeammateConfigVersionError,
    );
  });

  it('moves a version 1 document to the follow-up ladder, on, whatever it had', () => {
    for (const old of [
      { enabled: false, maxNudges: 2 },
      { enabled: true, maxNudges: 5 },
      undefined,
    ]) {
      const c = parseTeammateConfig({ version: 1, followUp: old });
      expect(c.version).toBe(TEAMMATE_CONFIG_VERSION);
      expect(c.followUp).toEqual({
        enabled: true,
        neverReplied: true,
        chaseTimes: true,
        ladder: [...DEFAULT_FOLLOW_UP_LADDER],
        monthlyForMonths: 6,
      });
    }
    // A version 2 document keeps what the owner chose.
    const off = parseTeammateConfig({ version: 2, followUp: { enabled: false } });
    expect(off.followUp.enabled).toBe(false);
    expect(off.followUp.ladder).toEqual([...DEFAULT_FOLLOW_UP_LADDER]);
  });

  it('moves a version 2 ladder of hours to steps with units, whole days as days', () => {
    const c = parseTeammateConfig({
      version: 2,
      followUp: { enabled: false, ladderHours: [6, 24, 36, 168], monthlyForMonths: 2 },
    });
    expect(c.followUp).toEqual({
      enabled: false,
      neverReplied: true,
      chaseTimes: true,
      ladder: [
        { after: 6, unit: 'hours' },
        { after: 1, unit: 'days' },
        { after: 36, unit: 'hours' },
        { after: 7, unit: 'days' },
      ],
      monthlyForMonths: 2,
    });
    expect(c.followUp).not.toHaveProperty('ladderHours');
  });

  it('works out when each follow-up goes: the ladder, then monthly, then none', () => {
    const f = {
      ladder: [
        { after: 10, unit: 'minutes' },
        { after: 4, unit: 'hours' },
        { after: 2, unit: 'weeks' },
        { after: 1, unit: 'months' },
      ] satisfies FollowUpStep[],
      monthlyForMonths: 2,
    };
    const M = 60_000;
    const month = 30 * 24 * 60;
    expect(followUpScheduleMinutes(f)).toEqual([
      10,
      240,
      14 * 24 * 60,
      month,
      2 * month,
      3 * month,
    ]);
    expect(followUpDueAt(f, 0, 1)).toBe(10 * M);
    expect(followUpDueAt(f, 1000, 3)).toBe(1000 + 14 * 24 * 60 * M);
    expect(followUpDueAt(f, 0, 6)).toBe(3 * month * M);
    expect(followUpDueAt(f, 0, 7)).toBeNull();
    expect(
      followUpScheduleMinutes({ ladder: [{ after: 1, unit: 'years' }], monthlyForMonths: 0 }),
    ).toEqual([365 * 24 * 60]);
  });

  it('says the ladder in plain words', () => {
    expect(followUpLadderWords(DEFAULT_FOLLOW_UP_LADDER)).toBe(
      '4 hours, then days 1, 2, 4, 7, 10, 14, 21 and 30',
    );
    expect(followUpLadderWords([{ after: 1, unit: 'days' }])).toBe('day 1');
    expect(
      followUpLadderWords([
        { after: 2, unit: 'hours' },
        { after: 6, unit: 'hours' },
      ]),
    ).toBe('2 hours, 6 hours');
    expect(
      followUpLadderWords([
        { after: 1, unit: 'minutes' },
        { after: 20, unit: 'minutes' },
        { after: 1, unit: 'hours' },
        { after: 2, unit: 'weeks' },
        { after: 3, unit: 'weeks' },
        { after: 2, unit: 'months' },
        { after: 1, unit: 'years' },
      ]),
    ).toBe('1 minute, 20 minutes, then 1 hour, then weeks 2 and 3, then month 2, then year 1');
  });

  it('refuses a ladder that goes backwards, is empty, runs too long, or is too soon or too late', () => {
    const h = (after: number) => ({ after, unit: 'hours' });
    for (const followUp of [
      { ladder: [h(24), h(4)] },
      { ladder: [h(4), h(4)] },
      { ladder: [{ after: 1, unit: 'days' }, h(24)] },
      { ladder: [] },
      { ladder: Array.from({ length: 21 }, (_, i) => h(i + 1)) },
      { ladder: [{ after: 4, unit: 'minutes' }] },
      { ladder: [{ after: 6, unit: 'years' }] },
      { ladder: [{ after: 0, unit: 'days' }] },
      { ladder: [{ after: 1.5, unit: 'days' }] },
      { ladder: [{ after: 1, unit: 'fortnights' }] },
      { monthlyForMonths: 13 },
    ])
      expect(() => parseTeammateConfig({ version: 3, followUp }), JSON.stringify(followUp)).toThrow(
        ZodError,
      );
    // The soonest and the latest are fine, and so are 20 of them.
    expect(
      parseTeammateConfig({
        version: 3,
        followUp: {
          ladder: [
            { after: 5, unit: 'minutes' },
            ...Array.from({ length: 18 }, (_, i) => h(i + 1)),
            { after: 5, unit: 'years' },
          ],
        },
      }).followUp.ladder,
    ).toHaveLength(20);
  });

  it('runs upgrade steps in order up to the target version', () => {
    const steps = {
      1: (doc: Record<string, unknown>) => ({ ...doc, renamed: doc.old, old: undefined }),
      2: (doc: Record<string, unknown>) => ({ ...doc, third: true }),
    };
    expect(upgradeTeammateConfig({ version: 1, old: 'x' }, steps, 3)).toEqual({
      version: 3,
      renamed: 'x',
      old: undefined,
      third: true,
    });
    expect(() => upgradeTeammateConfig({ version: 1 }, {}, 2)).toThrow(/No upgrade from/);
  });

  it('rejects invalid documents with field errors', () => {
    const q = (extra: Record<string, unknown>) => ({ id: 'a', question: 'A?', ...extra });
    const bad: Record<string, unknown>[] = [
      { identity: { name: '' } },
      { identity: { disclosure: 'never' } },
      { autonomy: { approvalsNeeded: 4 } },
      { autonomy: { approvalsNeeded: 201 } },
      { autonomy: { draftExpiresMinutes: 5 } },
      { limits: { dailySharePercent: 5 } },
      { limits: { repliesPerConversationPerDay: 0 } },
      { money: { maxPercent: 60 } },
      { hours: { mode: 'custom', custom: [] } },
      { hours: { mode: 'custom', custom: [{ day: 1, start: '17:00', end: '09:00' }] } },
      { channels: { emailAddressId: 'not-a-uuid' } },
      { book: { calendarIds: [SERVICE_CAL, SERVICE_CAL] } },
      { respond: { newLeads: { channel: 'chat' } } },
      { qualify: { questions: [q({ kind: 'choice', options: ['Only one'] })] } },
      {
        qualify: {
          questions: [q({ kind: 'choice', options: ['X', 'Y'], notAFitIf: { answers: ['Z'] } })],
        },
      },
      { qualify: { questions: [q({ kind: 'yes_no', notAFitIf: { answers: ['yes', 'no'] } })] } },
      { qualify: { questions: [q({ kind: 'text', notAFitIf: { answers: ['no'] } })] } },
      { qualify: { questions: [q({ kind: 'text', notAFitIf: { below: 5 } })] } },
      { qualify: { questions: [q({ kind: 'number', notAFitIf: { below: 10, above: 5 } })] } },
      { qualify: { questions: [q({}), q({ question: 'B?' })] } },
      { handOff: { tellCustomer: 'Hi {name}, {expectation}' } },
      { handOff: { sensitiveTopics: ['Insurance', 'insurance'] } },
      { handOff: { notify: { kind: 'users', userIds: [] } } },
    ];
    for (const patch of bad)
      expect(() => parseTeammateConfig({ version: 2, ...patch }), JSON.stringify(patch)).toThrow(
        ZodError,
      );
  });

  it('accepts every question shape the builder offers', () => {
    const c = parseTeammateConfig({
      version: 1,
      qualify: {
        enabled: true,
        questions: [
          {
            id: 'need',
            question: 'What do you need?',
            kind: 'choice',
            options: ['Repair', 'New system'],
            notAFitIf: { answers: ['Repair'] },
          },
          {
            id: 'owner',
            question: 'Do you own the home?',
            kind: 'yes_no',
            notAFitIf: { answers: ['no'] },
          },
          {
            id: 'budget',
            question: 'What’s your budget?',
            kind: 'number',
            notAFitIf: { below: 1000, above: 50000 },
          },
          { id: 'zip', question: 'ZIP?' },
          {
            id: 'bill',
            question: 'A photo of your latest electric bill',
            kind: 'file',
            notify: { kind: 'lead_assignee' },
          },
        ],
      },
    });
    expect(c.qualify.questions[3]).toEqual({
      id: 'zip',
      question: 'ZIP?',
      kind: 'text',
      options: [],
      required: true,
      notAFitIf: { answers: [], below: null, above: null },
      notify: null,
    });
    expect(c.qualify.questions[4]).toMatchObject({
      kind: 'file',
      notify: { kind: 'lead_assignee' },
    });
  });

  it('lets only a file question tell anyone, and never rules a lead out by a file', () => {
    const parse = (q: Record<string, unknown>) =>
      TeammateConfig.safeParse({
        version: TEAMMATE_CONFIG_VERSION,
        qualify: { questions: [{ id: 'q1', question: 'Your electric bill', ...q }] },
      });
    expect(parse({ kind: 'file', notify: { kind: 'admins' } }).success).toBe(true);
    expect(parse({ kind: 'file', notify: null }).success).toBe(true);
    const told = parse({ kind: 'text', notify: { kind: 'admins' } });
    expect(told.success).toBe(false);
    expect(told.error?.issues[0]?.message).toBe(
      'Only a file question tells anyone when it’s answered.',
    );
    expect(parse({ kind: 'file', notAFitIf: { answers: ['yes'] } }).success).toBe(false);
    expect(parse({ kind: 'file', notAFitIf: { below: 3 } }).success).toBe(false);
  });
});

describe('applyTeammatePatch', () => {
  it('merges objects deeply and replaces lists', () => {
    const base = applyTeammatePatch(emptyTeammateConfig(), {
      book: { enabled: true, calendarIds: [SERVICE_CAL] },
    });
    const next = applyTeammatePatch(base, {
      book: { calendarIds: [] },
      respond: { newLeads: { delayMinutes: 5 } },
    });
    expect(next.book).toMatchObject({
      enabled: true,
      calendarIds: [],
      reschedule: true,
      cancel: true,
    });
    expect(next.respond.newLeads).toEqual({ enabled: true, channel: 'sms', delayMinutes: 5 });
    expect(base.book.calendarIds).toEqual([SERVICE_CAL]);
  });

  it('switches who hears about things between kinds, and null clears a nullable setting', () => {
    const users = applyTeammatePatch(emptyTeammateConfig(), {
      handOff: { notify: { kind: 'users', userIds: [DALE, PRIYA] } },
      qualify: { whenQualified: { stageId: STAGE_QUALIFIED, notify: { kind: 'lead_assignee' } } },
    });
    expect(users.handOff.notify).toEqual({ kind: 'users', userIds: [DALE, PRIYA] });
    const back = applyTeammatePatch(users, {
      handOff: { notify: { kind: 'admins' } },
      qualify: { whenQualified: { stageId: null, notify: null } },
    });
    expect(back.handOff.notify).toEqual({ kind: 'admins' });
    expect(back.qualify.whenQualified).toEqual({ stageId: null, notify: null, offerTimes: true });
  });

  it('throws when the result is invalid', () => {
    expect(() =>
      applyTeammatePatch(emptyTeammateConfig(), { autonomy: { approvalsNeeded: 1 } }),
    ).toThrow(ZodError);
  });
});

describe('presets', () => {
  it('are the plan’s three, plus Start from scratch', () => {
    expect(TEAMMATE_PRESETS.map((p) => p.name)).toEqual([
      'Lead Responder',
      'Lead Qualifier',
      'Appointment Coordinator',
      'Start from scratch',
    ]);
  });

  it.each(TEAMMATE_PRESET_KEYS)('%s is a complete, valid document', (key) => {
    const c = teammateConfigFromPreset(key, presetContext);
    expect(TeammateConfig.safeParse(c).success).toBe(true);
    expect(c.identity.name).toBe('Ava');
    expect(c.channels).toEqual({
      sms: true,
      email: true,
      emailAddressId: HELLO,
      chat: true,
      widgetId: WIDGET,
    });
  });

  it('prefill skills: questions for the Qualifier, calendars for the Coordinator', () => {
    const q = teammateConfigFromPreset('lead_qualifier', presetContext);
    expect(q.qualify.enabled).toBe(true);
    expect(q.qualify.questions.map((x) => x.id)).toEqual(['need', 'timeline', 'owner', 'zip']);
    const a = teammateConfigFromPreset('appointment_coordinator', presetContext);
    expect(a.book).toEqual({
      enabled: true,
      calendarIds: [SERVICE_CAL],
      reschedule: true,
      cancel: true,
      waitlist: true,
      repeats: false,
      serviceArea: true,
    });
    // A new teammate reaches the team on their phones, not by email.
    expect(a.handOff.alerts).toEqual({ push: true, text: true, email: false });
    expect(a.respond.newLeads.enabled).toBe(false);
    expect(teammateConfigFromPreset('appointment_coordinator').book.calendarIds).toEqual([]);
    expect(teammateConfigFromPreset('lead_responder', presetContext).followUp.enabled).toBe(true);
  });

  it('Blank turns every skill off, first messages to new leads too', () => {
    const c = teammateConfigFromPreset('blank', presetContext);
    expect({
      respond: c.respond.enabled,
      newLeads: c.respond.newLeads.enabled,
      answer: c.answer.enabled,
      qualify: c.qualify.enabled,
      book: c.book.enabled,
      followUp: c.followUp.enabled,
    }).toEqual({
      respond: false,
      newLeads: false,
      answer: false,
      qualify: false,
      book: false,
      followUp: false,
    });
    expect(inferTeammateLabels(c)).toEqual({ primary: 'custom', tags: ['custom'] });
    expect(TEAMMATE_PRESETS.find((p) => p.key === 'blank')!.description).toMatch(
      /^Nothing turned on\./,
    );
  });

  it('take the name and disclosure picked, and leave email and chat off without an address or widget', () => {
    const c = teammateConfigFromPreset('lead_responder', {
      name: '  Max ',
      disclosure: 'when_asked',
    });
    expect(c.identity).toMatchObject({ name: 'Max', disclosure: 'when_asked' });
    expect(c.channels).toEqual({
      sms: true,
      email: false,
      emailAddressId: null,
      chat: false,
      widgetId: null,
    });
  });

  it('suggest questions by industry, ruling nobody out', () => {
    expect(suggestedQuestions('home_services').map((q) => q.id)).toEqual([
      'need',
      'timeline',
      'owner',
      'zip',
    ]);
    expect(suggestedQuestions('other').map((q) => q.id)).toEqual(['need', 'timeline', 'budget']);
    expect(suggestedQuestions(null)).toEqual(suggestedQuestions('other'));
    for (const q of suggestedQuestions('home_services'))
      expect(q.notAFitIf).toEqual({ answers: [], below: null, above: null });
  });

  it('refuse an unknown preset', () => {
    expect(() => teammateConfigFromPreset('nope' as never)).toThrow(RangeError);
  });
});

describe('labels never gate a setting', () => {
  const edits: Record<string, TeammatePatch> = {
    identity: {
      identity: { name: 'Max', disclosure: 'when_asked', signature: '– Max', toneNote: 'Warm' },
    },
    channels: {
      channels: { sms: false, email: true, emailAddressId: OFFICE, chat: false, widgetId: null },
    },
    respond: {
      respond: { enabled: false, newLeads: { enabled: false, channel: 'email', delayMinutes: 30 } },
    },
    answer: { answer: { enabled: false, whenUnsure: 'take_message' } },
    qualify: {
      qualify: {
        enabled: true,
        questions: [{ id: 'q', question: 'Budget?', kind: 'number' }],
        whenQualified: { stageId: STAGE_QUALIFIED, notify: { kind: 'admins' } },
      },
    },
    book: { book: { enabled: true, calendarIds: [SERVICE_CAL], reschedule: false, cancel: false } },
    followUp: {
      followUp: {
        enabled: true,
        ladder: [
          { after: 30, unit: 'minutes' },
          { after: 1, unit: 'weeks' },
        ],
        monthlyForMonths: 0,
      },
    },
    hours: { hours: { mode: 'custom', custom: [{ day: 6, start: '10:00', end: '14:00' }] } },
    autonomy: { autonomy: { approvalsNeeded: 5, draftExpiresMinutes: 60 } },
    limits: {
      limits: { repliesPerConversationPerDay: 3, toolRounds: 2, dailySharePercent: 100 },
    },
    money: { money: { discounts: 'with_approval', maxPercent: 25 } },
    handOff: {
      handOff: {
        onFrustration: false,
        sensitiveTopics: ['insurance'],
        notify: { kind: 'person_owner' },
        tellCustomer: 'Someone will follow up {expectation}.',
      },
    },
  };

  it.each(TEAMMATE_PRESET_KEYS)('every module is editable on a %s teammate', (key) => {
    const config = teammateConfigFromPreset(key, presetContext);
    for (const [module, patch] of Object.entries(edits)) {
      const next = applyTeammatePatch(config, patch);
      expect(TeammateConfig.safeParse(next).success, `${key} ${module}`).toBe(true);
      expect(() => inferTeammateLabels(next)).not.toThrow();
    }
  });
});

describe('qualificationOf', () => {
  const questions = applyTeammatePatch(emptyTeammateConfig(), {
    qualify: {
      questions: [
        {
          id: 'need',
          question: 'What do you need?',
          kind: 'choice',
          options: ['Repair', 'New system'],
          notAFitIf: { answers: ['Repair'] },
        },
        {
          id: 'owner',
          question: 'Do you own the home?',
          kind: 'yes_no',
          notAFitIf: { answers: ['no'] },
        },
        { id: 'budget', question: 'Budget?', kind: 'number', notAFitIf: { below: 3000 } },
        { id: 'notes', question: 'Anything else?', required: false },
      ],
    },
  }).qualify.questions;

  it('qualifies a lead once every required answer is in and none rules them out', () => {
    expect(
      qualificationOf(questions, { need: 'new system', owner: 'Yes we do', budget: '$5k' }),
    ).toEqual({ status: 'qualified', missing: [], notAFit: [] });
  });

  it('is incomplete while a required answer is missing (optional ones don’t count)', () => {
    expect(qualificationOf(questions, { need: 'New system', owner: 'yep', budget: ' ' })).toEqual({
      status: 'incomplete',
      missing: ['budget'],
      notAFit: [],
    });
  });

  it('rules a lead out by a choice, a yes/no, or a number out of range', () => {
    expect(
      qualificationOf(questions, { need: 'repair', owner: 'Nope, renting', budget: '1,500' }),
    ).toEqual({ status: 'not_a_fit', missing: [], notAFit: ['need', 'owner', 'budget'] });
  });

  it('only a clear answer rules a lead out', () => {
    expect(
      qualificationOf(questions, {
        need: 'Something odd',
        owner: 'maybe',
        budget: 'not sure',
        other: 'x',
      }),
    ).toEqual({ status: 'qualified', missing: [], notAFit: [] });
  });

  it('waits for a required file until one comes, and never rules a lead out by it', () => {
    const withBill = applyTeammatePatch(emptyTeammateConfig(), {
      qualify: {
        questions: [
          { id: 'owner', question: 'Do you own the home?', kind: 'yes_no' },
          {
            id: 'bill',
            question: 'A photo of your latest electric bill',
            kind: 'file',
            notify: { kind: 'admins' },
          },
        ],
      },
    }).qualify.questions;
    expect(qualificationOf(withBill, { owner: 'yes' })).toEqual({
      status: 'incomplete',
      missing: ['bill'],
      notAFit: [],
    });
    expect(qualificationOf(withBill, { owner: 'yes', bill: 'Sent “bill.pdf”' })).toEqual({
      status: 'qualified',
      missing: [],
      notAFit: [],
    });
  });
});
