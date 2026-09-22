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
  defaultAutomationSettings,
  parseAutomationSettings,
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
    const alwaysOn: AttentionKind[] = ['wallet_empty', 'wallet_card_declined'];
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
      if (a.customerFacing === 'ai') expect(a.needs, a.id).toContain('teammate_on');
      if (a.customerFacing !== null) expect(a.effect, a.id).toBe('texts');
    }
  });
});

describe('automation settings', () => {
  it('turns every switch it owns on by default, so nothing a business had stops working', () => {
    expect(defaultAutomationSettings().switches).toEqual({
      dayBefore: true,
      dayOf: true,
      waitlist: true,
      morningBrief: true,
    });
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

  it('reads the teammate’s own defaults: greeting new leads on, follow-ups off', () => {
    const rows = new Map(
      automationRows(ctx({ teammate: teammate('automatic') })).map((r) => [r.def.id, r.on]),
    );
    expect(rows.get('new_lead_greeting')).toBe(true);
    expect(rows.get('follow_ups_after_silence')).toBe(false);
  });

  it('starts each row where a new business starts, as its catalog entry says', () => {
    for (const row of automationRows(ctx({ teammate: teammate('training') })))
      expect(row.on, row.def.id).toBe(row.def.defaultOn);
  });

  it('counts what is working, and what is on but waiting to be set up', () => {
    // Follow-ups are off by the teammate's own default; everything else works.
    const rows = automationRows(ctx({ teammate: teammate('automatic') }));
    expect(automationCounts(rows)).toEqual({
      working: rows.length - 1,
      needsSetup: 0,
      total: rows.length,
    });
    // No teammate: its rows read as a new one starts (greeting on, follow-ups off), and neither works yet.
    const none = automationRows(ctx());
    expect(automationCounts(none)).toEqual({
      working: none.length - 2,
      needsSetup: 1,
      total: none.length,
    });
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
      settings: { switches: { ...defaultAutomationSettings().switches, waitlist: false } },
    });
  });

  it('writes a teammate skill into its settings, and leaves the rest alone', () => {
    const t = teammate('training');
    const patch = automationPatch('follow_ups_after_silence', true, ctx({ teammate: t }));
    expect(patch?.store).toBe('teammate');
    if (patch?.store !== 'teammate') return;
    const followUp = patch.config['followUp'] as Record<string, unknown>;
    expect(followUp['enabled']).toBe(true);
    expect(followUp['maxNudges']).toBe(
      (t.config['followUp'] as Record<string, unknown>)['maxNudges'],
    );
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
