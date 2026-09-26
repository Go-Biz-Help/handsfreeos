import { describe, expect, it } from 'vitest';
import {
  ATTENTION_KINDS,
  defaultAttentionSettings,
  type AttentionKind,
} from '../src/attention/index';
import {
  AUTOMATION_GROUPS,
  AUTOMATION_SECTIONS,
  AUTOMATIONS,
  automationCounts,
  automationPatch,
  automationRow,
  automationRows,
  automationSettingsOf,
  DEFAULT_REENGAGE_TEMPLATE,
  defaultAutomationSettings,
  parseAutomationSettings,
  DEFAULT_INTAKE_MESSAGE,
  DEFAULT_MAINTENANCE_PLAN_TEMPLATE,
  DEFAULT_MAINTENANCE_TEMPLATE,
  everyMonthsWords,
  intakeFormOf,
  maintenanceDueOn,
  maintenanceScheduleOf,
  maintenanceTemplateProblem,
  renderMaintenance,
  intakeMessageProblem,
  mayMentionReferral,
  reengageOn,
  renderIntakeMessage,
  sendModeOf,
  type AutomationContext,
  type AutomationDef,
} from '../src/automations/index';
import { emptyTeammateConfig } from '../src/ai-team/index';

const ctx = (over: Partial<AutomationContext> = {}): AutomationContext => ({
  attention: defaultAttentionSettings(),
  automations: defaultAutomationSettings(),
  teammate: null,
  ...over,
});
const teammate = (status: 'off' | 'training' | 'automatic') => ({
  status,
  config: emptyTeammateConfig() as unknown as Record<string, unknown>,
});
const def = (id: string) => AUTOMATIONS.find((a) => a.id === id)! as AutomationDef;

describe('the automations catalog', () => {
  it('gives every automation its own id', () => {
    const ids = AUTOMATIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts every group in exactly one section, in the catalog’s group order', () => {
    expect(AUTOMATION_SECTIONS.flatMap((s) => s.groups)).toEqual([...AUTOMATION_GROUPS]);
  });

  it('keeps each group together, in the page’s order', () => {
    const order = AUTOMATIONS.map((a) => AUTOMATION_GROUPS.indexOf(a.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('gives every switchable Action Center kind exactly one row', () => {
    // The two wallet kinds that mean the business has stopped working are always on, and not switches.
    // A customer nobody could thank is always looked for: "Thank-you after the job" is its switch.
    const alwaysOn: AttentionKind[] = [
      'wallet_empty',
      'wallet_card_declined',
      'job_not_thanked',
      'maintenance_due',
      // "Did the job happen?" is its switch.
      'job_unconfirmed',
    ];
    const bound = AUTOMATIONS.flatMap((a) =>
      a.binding.store === 'attention_kind' ? [...a.binding.kinds] : [],
    );
    expect(new Set(bound).size).toBe(bound.length);
    expect([...bound].sort()).toEqual(ATTENTION_KINDS.filter((k) => !alwaysOn.includes(k)).sort());
  });

  it('writes one plain sentence for each', () => {
    for (const a of AUTOMATIONS) {
      expect(a.label.length, a.id).toBeLessThanOrEqual(40);
      expect(a.oneLiner, a.id).toMatch(/^[A-Z].*\.$/);
      expect(a.oneLiner.length, a.id).toBeLessThanOrEqual(100);
    }
  });

  it('only lets the AI teammate write to customers through its own switches', () => {
    for (const a of AUTOMATIONS as readonly AutomationDef[]) {
      // Unless, like the thank-you, it does something else without one (and says what).
      if (a.customerFacing === 'ai' && !a.withoutTeammate)
        expect(a.needs, a.id).toContain('teammate_on');
      if (a.customerFacing !== null) expect(['texts', 'calls'], a.id).toContain(a.effect);
    }
  });
});

describe('automation settings', () => {
  it('turns on every switch for what a business already had, and leaves re-engaging off', () => {
    expect(defaultAutomationSettings().switches).toEqual({
      callBackMissed: false,
      callQuotes: false,
      callConfirmVisits: false,
      dayBefore: true,
      dayOf: true,
      waitlist: true,
      morningBrief: true,
      eveningBrief: true,
      reengage: false,
      intake: true,
      thankYou: true,
      maintenance: true,
      pipelineMoves: true,
      engagedLeads: true,
      jobCheck: true,
      handoffFollowUp: true,
      approvalExpiry: true,
      aiTags: true,
      aiDetails: true,
    });
    expect(defaultAutomationSettings().reengage).toEqual({
      template: DEFAULT_REENGAGE_TEMPLATE,
      reviewedAt: null,
      afterDays: 90,
      maxPerDay: 20,
      cooldownDays: 180,
    });
  });

  it('keeps re-engaging off until an owner has read the message', () => {
    expect(() => parseAutomationSettings({ switches: { reengage: true } })).toThrow(
      /Looks good, turn on/,
    );
    const reviewed = parseAutomationSettings({
      switches: { reengage: true },
      reengage: { reviewedAt: '2026-09-22T12:00:00.000Z' },
    });
    expect(reengageOn(reviewed)).toBe(true);
    // Stored on without a review (hand-edited): read as off, and the rest is kept.
    const read = automationSettingsOf({
      automations: { switches: { reengage: true, dayOf: false } },
    });
    expect(read.switches).toMatchObject({ reengage: false, dayOf: false });
    expect(reengageOn(read)).toBe(false);
  });

  it('refuses re-engage wording it can’t fill, and numbers out of range', () => {
    for (const reengage of [
      { template: 'Hi {name}' },
      { template: '' },
      { afterDays: 7 },
      { maxPerDay: 0 },
      { cooldownDays: 5000 },
    ])
      expect(() => parseAutomationSettings({ reengage }), JSON.stringify(reengage)).toThrow();
  });

  it('reads a bad or missing document field by field', () => {
    expect(automationSettingsOf(null)).toEqual(defaultAutomationSettings());
    expect(automationSettingsOf({ automations: 'nonsense' })).toEqual(defaultAutomationSettings());
    const read = automationSettingsOf({
      automations: { switches: { dayBefore: false, dayOf: 'yes', unknown: true } },
    });
    expect(read.switches.dayBefore).toBe(false);
    expect(read.switches.dayOf).toBe(true);
  });

  it('refuses a bad switch on save', () => {
    expect(() => parseAutomationSettings({ switches: { waitlist: 'no' } })).toThrow();
  });
});

describe('automation rows', () => {
  it('reads each switch where it lives', () => {
    const attention = defaultAttentionSettings();
    const off = automationRows(
      ctx({
        attention: { ...attention, kinds: { ...attention.kinds, customer_waiting: false } },
        automations: {
          ...defaultAutomationSettings(),
          switches: { ...defaultAutomationSettings().switches, dayOf: false },
        },
      }),
    );
    const byId = new Map(off.map((r) => [r.def.id, r]));
    // Two kinds behind one row: it's on only when both are.
    expect(byId.get('unanswered_alert')!.on).toBe(false);
    expect(byId.get('day_of_reminder')!.on).toBe(false);
    expect(byId.get('day_before_confirmation')!.on).toBe(true);
    expect(byId.get('hot_lead_alert')!.on).toBe(true);
  });

  it('keeps approvals on whatever is stored', () => {
    const attention = defaultAttentionSettings();
    const row = automationRow(
      def('drafts_awaiting_review'),
      ctx({ attention: { ...attention, kinds: { ...attention.kinds, ai_approval: false } } }),
    );
    expect(row).toMatchObject({ on: true, locked: true });
    expect(automationPatch('drafts_awaiting_review', false, ctx())).toBeNull();
  });

  it('asks for the AI teammate before an AI-written automation can work', () => {
    expect(automationRow(def('new_lead_greeting'), ctx()).needsSetup?.text).toBe(
      'Set up your AI teammate to start.',
    );
    expect(
      automationRow(def('new_lead_greeting'), ctx({ teammate: teammate('off') })).needsSetup?.text,
    ).toBe('Turn on your AI teammate to start.');
    const training = automationRow(
      def('new_lead_greeting'),
      ctx({ teammate: teammate('training') }),
    );
    expect(training).toMatchObject({ on: true, working: true, needsSetup: null, drafts: true });
    const graduated = automationRow(
      def('new_lead_greeting'),
      ctx({ teammate: teammate('automatic') }),
    );
    expect(graduated.drafts).toBe(false);
    // Fixed wording never waits on the teammate.
    expect(automationRow(def('day_before_confirmation'), ctx()).needsSetup).toBeNull();
  });

  it('says the New lead greeting isn’t working while the teammate’s Respond switch is off', () => {
    const quiet = teammate('automatic');
    (quiet.config['respond'] as Record<string, unknown>)['enabled'] = false;
    const row = automationRow(def('new_lead_greeting'), ctx({ teammate: quiet }));
    // Its own switch is still on: only Respond is missing.
    expect(row).toMatchObject({
      on: true,
      working: false,
      needsSetup: { code: 'respond_on', text: 'Turn on Respond for your AI teammate to start.' },
    });
    expect(automationCounts(automationRows(ctx({ teammate: quiet }))).needsSetup).toBe(2);
    // An AI teammate that's off says that first.
    const off = { ...quiet, status: 'off' as const };
    expect(automationRow(def('new_lead_greeting'), ctx({ teammate: off })).needsSetup?.code).toBe(
      'teammate_on',
    );
    expect(
      automationRow(def('new_lead_greeting'), ctx({ teammate: teammate('automatic') })).working,
    ).toBe(true);
  });

  it('reads the teammate’s own defaults: greeting new leads and following up on', () => {
    const rows = new Map(
      automationRows(ctx({ teammate: teammate('automatic') })).map((r) => [r.def.id, r.on]),
    );
    expect(rows.get('new_lead_greeting')).toBe(true);
    expect(rows.get('follow_ups_after_silence')).toBe(true);
    // A teammate that turned follow-ups off.
    const off = teammate('automatic');
    (off.config['followUp'] as Record<string, unknown>)['enabled'] = false;
    expect(automationRow(def('follow_ups_after_silence'), ctx({ teammate: off })).on).toBe(false);
  });

  it('starts each row where a new business starts, as its catalog entry says', () => {
    for (const row of automationRows(ctx({ teammate: teammate('training') })))
      expect(row.on, row.def.id).toBe(row.def.defaultOn);
  });

  it('counts what is working, and what is on but waiting to be set up', () => {
    // Everything works but re-engaging and the three AI calls, which start off, and intake questions, which
    // waits for a form.
    const rows = automationRows(ctx({ teammate: teammate('automatic') }));
    expect(automationCounts(rows)).toEqual({
      working: rows.length - 5,
      needsSetup: 1,
      total: rows.length,
    });
    // No teammate: its four rows read as a new one starts (all on), and none works yet, nor the three health
    // rows about its work. The thank-you still works: a card asks a person instead. The three AI calls start off.
    const none = automationRows(ctx());
    expect(automationCounts(none)).toEqual({
      working: none.length - 12,
      needsSetup: 8,
      total: none.length,
    });
    expect(automationRow(def('job_thank_you'), ctx()).fallback).toMatch(/card on Home/);
    expect(
      automationRow(def('job_thank_you'), ctx({ teammate: teammate('automatic') })).fallback,
    ).toBeNull();
  });

  it('asks for a form before intake questions can go', () => {
    expect(automationRow(def('intake_questions'), ctx()).needsSetup).toEqual({
      code: 'intake_form',
      text: 'Pick a form to start.',
    });
    const chosen = {
      ...defaultAutomationSettings(),
      intake: {
        ...defaultAutomationSettings().intake,
        formId: '00000000-0000-4000-8000-000000000001',
      },
    };
    expect(automationRow(def('intake_questions'), ctx({ automations: chosen }))).toMatchObject({
      on: true,
      working: true,
      needsSetup: null,
    });
    expect(intakeFormOf(chosen)).toBe('00000000-0000-4000-8000-000000000001');
    expect(intakeFormOf({ ...chosen, switches: { ...chosen.switches, intake: false } })).toBeNull();
  });

  it('won’t turn re-engaging on until its message is read, and always lets it off', () => {
    expect(automationRow(def('reengage_dead_leads'), ctx()).awaitingReview).toBe(true);
    expect(automationPatch('reengage_dead_leads', true, ctx())).toBeNull();
    const read = {
      ...defaultAutomationSettings(),
      reengage: { ...defaultAutomationSettings().reengage, reviewedAt: '2026-09-22T12:00:00.000Z' },
    };
    expect(
      automationRow(def('reengage_dead_leads'), ctx({ automations: read })).awaitingReview,
    ).toBe(false);
    const on = automationPatch('reengage_dead_leads', true, ctx({ automations: read }));
    expect(on?.store === 'automations' && on.settings.switches.reengage).toBe(true);
    expect(automationPatch('reengage_dead_leads', false, ctx())).not.toBeNull();
  });
});

describe('automation switches', () => {
  it('writes an Action Center row into the attention settings, every kind it names', () => {
    const patch = automationPatch('unanswered_alert', false, ctx());
    expect(patch?.store).toBe('attention');
    if (patch?.store !== 'attention') return;
    expect(patch.settings.kinds.unanswered_lead).toBe(false);
    expect(patch.settings.kinds.customer_waiting).toBe(false);
    expect(patch.settings.kinds.hot_lead).toBe(true);
  });

  it('writes its own switches into the automations settings', () => {
    const patch = automationPatch('waitlist_slot_opened', false, ctx());
    expect(patch).toEqual({
      store: 'automations',
      settings: {
        ...defaultAutomationSettings(),
        switches: { ...defaultAutomationSettings().switches, waitlist: false },
      },
    });
  });

  it('writes a teammate skill into its settings, and leaves the rest alone', () => {
    const t = teammate('training');
    const patch = automationPatch('chase_offered_time', false, ctx({ teammate: t }));
    expect(patch?.store).toBe('teammate');
    if (patch?.store !== 'teammate') return;
    const followUp = patch.config['followUp'] as Record<string, unknown>;
    expect(followUp['chaseTimes']).toBe(false);
    expect(followUp['enabled']).toBe(true);
    expect(followUp['ladder']).toEqual((t.config['followUp'] as Record<string, unknown>)['ladder']);
    expect(patch.config['identity']).toEqual(t.config['identity']);
    // Nothing to write to without a teammate.
    expect(automationPatch('follow_ups_after_silence', true, ctx())).toBeNull();
  });
});

describe('who sends what', () => {
  it('sends fixed wording whatever the teammate is doing', () => {
    for (const status of [null, 'off', 'training', 'automatic'] as const)
      expect(sendModeOf('owner_wording', status)).toBe('send');
  });

  it('drafts what the AI writes while it trains, sends once it graduates, and never while it is off', () => {
    expect(sendModeOf('ai', 'training')).toBe('draft');
    expect(sendModeOf('ai', 'automatic')).toBe('send');
    expect(sendModeOf('ai', 'off')).toBe('blocked');
    expect(sendModeOf('ai', null)).toBe('blocked');
  });
});

describe('the intake message', () => {
  it('starts with wording that carries the link, and fills it in', () => {
    expect(intakeMessageProblem(DEFAULT_INTAKE_MESSAGE)).toBeNull();
    expect(
      renderIntakeMessage(DEFAULT_INTAKE_MESSAGE, {
        firstName: 'Maria',
        businessName: 'Lone Star HVAC',
        link: 'https://book.example.com/f/ls/intake',
      }),
    ).toBe(
      'Hi Maria, thanks for booking with Lone Star HVAC! Before your visit, could you answer a few quick questions? https://book.example.com/f/ls/intake',
    );
    expect(
      renderIntakeMessage('Hi {firstName}: {link}', {
        firstName: null,
        businessName: 'X',
        link: 'L',
      }),
    ).toBe('Hi there: L');
  });

  it('refuses wording without the link, or with a slot it can’t fill', () => {
    expect(intakeMessageProblem('Please fill in our form')).toMatch(/\{link\}/);
    expect(intakeMessageProblem('Hi {name}, {link}')).toMatch(/can't be filled in/);
    expect(intakeMessageProblem('Hi {{firstName}}, {link}')).toMatch(/can't be filled in/);
    expect(() => parseAutomationSettings({ intake: { message: 'No link here' } })).toThrow();
    expect(() => parseAutomationSettings({ intake: { formId: 'not-a-uuid' } })).toThrow();
  });
});

describe('the referral word check', () => {
  it('lets through words that might be about somebody who needs the business', () => {
    for (const text of [
      'My neighbor Jan needs her AC looked at, 713-555-0199',
      'my sister is looking for someone to fix her furnace',
      'I recommended you to my boss',
      'Can I pass along your number to a friend?',
      'I know someone who needs a new water heater',
    ])
      expect(mayMentionReferral(text), text).toBe(true);
  });

  it('leaves out the rest, cheaply', () => {
    for (const text of [
      'Thanks, see you Tuesday',
      'My friend dropped me off',
      'What time are you coming?',
      '',
      null,
    ])
      expect(mayMentionReferral(text), String(text)).toBe(false);
  });
});

describe('maintenance due', () => {
  it('asks for a repeating service before it can work', () => {
    expect(
      automationRow(def('maintenance_due'), ctx({ maintenanceReady: false })).needsSetup,
    ).toEqual({
      code: 'maintenance_schedule',
      text: 'Set how often a service repeats to start.',
    });
    expect(automationRow(def('maintenance_due'), ctx({ maintenanceReady: true })).working).toBe(
      true,
    );
  });

  it('takes how often from the customer, then their plan, then the service', () => {
    expect(maintenanceScheduleOf({ customer: 3, plan: 12, service: 6 })).toEqual({
      everyMonths: 3,
      source: 'customer',
    });
    // "Never" is theirs to choose too.
    expect(maintenanceScheduleOf({ customer: null, plan: 12, service: 6 })).toEqual({
      everyMonths: null,
      source: 'customer',
    });
    expect(maintenanceScheduleOf({ plan: 12, service: 6 })).toEqual({
      everyMonths: 12,
      source: 'plan',
    });
    expect(maintenanceScheduleOf({ plan: null, service: 6 })).toEqual({
      everyMonths: 6,
      source: 'service',
    });
    expect(maintenanceScheduleOf({})).toEqual({ everyMonths: null, source: null });
  });

  it('counts months on the calendar, the 31st landing on the month’s last day', () => {
    expect(maintenanceDueOn('2026-03-15', 6)).toBe('2026-09-15');
    expect(maintenanceDueOn('2026-08-31', 6)).toBe('2027-02-28');
    expect(maintenanceDueOn('2027-08-31', 6)).toBe('2028-02-29');
    expect(maintenanceDueOn('2026-11-02', 12)).toBe('2027-11-02');
    expect(everyMonthsWords(6)).toBe('every 6 months');
    expect(everyMonthsWords(12)).toBe('every year');
    expect(everyMonthsWords(24)).toBe('every 2 years');
    expect(everyMonthsWords(1)).toBe('every month');
  });

  it('writes the reminder in the business’s words, with the plan for members', () => {
    const v = {
      firstName: 'Maria',
      businessName: 'Lone Star HVAC',
      service: 'AC tune-up',
      link: 'https://book.example.com/book/ls/ac?service=1',
      plan: 'Comfort Club',
    };
    expect(renderMaintenance(DEFAULT_MAINTENANCE_TEMPLATE, v)).toBe(
      "Hi Maria, it's Lone Star HVAC. Your AC tune-up is due soon. Book a time that suits you here: https://book.example.com/book/ls/ac?service=1",
    );
    expect(renderMaintenance(DEFAULT_MAINTENANCE_PLAN_TEMPLATE, v)).toContain(
      "it's included in your Comfort Club",
    );
    expect(maintenanceTemplateProblem(DEFAULT_MAINTENANCE_TEMPLATE, { plan: false })).toBeNull();
    // {plan} only in the members' wording, and the link always.
    expect(maintenanceTemplateProblem('Your {plan} visit: {link}', { plan: false })).toMatch(
      /can't be filled in/,
    );
    expect(maintenanceTemplateProblem('Your {service} is due!', { plan: false })).toMatch(
      /\{link\}/,
    );
    expect(() => parseAutomationSettings({ maintenance: { template: 'No link' } })).toThrow();
    expect(defaultAutomationSettings().maintenance).toMatchObject({
      leadDays: 14,
      secondAfterDays: 7,
      maxPerDay: 20,
    });
  });
});

describe('the end-of-day email', () => {
  it('goes at 6 PM unless the business picks another time between noon and 10 PM', () => {
    expect(defaultAutomationSettings().briefings).toEqual({ eveningAt: '18:00' });
    expect(parseAutomationSettings({ briefings: { eveningAt: '20:30' } }).briefings.eveningAt).toBe(
      '20:30',
    );
    for (const eveningAt of ['07:00', '23:00', '6 PM', '25:00'])
      expect(() => parseAutomationSettings({ briefings: { eveningAt } }), eveningAt).toThrow();
  });
});
