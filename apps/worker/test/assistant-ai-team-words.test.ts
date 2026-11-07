/**
 * How the Assistant reads the AI teammate's screens, without a database: a funnel whole while it fits, an outline when
 * it doesn't (each message cut short), one stage whole by its stageId, and a save's changes as the builder says them,
 * never as ids; and the teammate's own settings, whose fixes say which screen they open rather than a bare path.
 */
import { FunnelDefinition, type FunnelDefinitionInput } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { funnelChangeLines, funnelRead } from '../src/assistant/tools-funnels';
import { teammateRead } from '../src/assistant/tools-settings';

describe('the AI teammate’s settings, as get_settings reads them', () => {
  it('says which screen a fix opens, never its path, and keeps a fix it makes itself as it is', () => {
    const patch = { id: 'turn_on_texting', label: 'Use text', patch: { channels: { sms: true } } };
    const read = teammateRead({
      teammate: { name: 'Ava' },
      issues: [
        {
          code: 'no_texting',
          severity: 'error',
          message: 'Texting isn’t set up.',
          fields: ['channels.sms'],
          fixes: [{ id: 'texting', label: 'Set up texting', href: 'settings/texting' }, patch],
        },
      ],
    }) as { teammate: unknown; issues: { fixes: Record<string, unknown>[] }[] };
    expect(read.teammate).toEqual({ name: 'Ava' });
    expect(read.issues[0]!.fixes).toEqual([
      { id: 'texting', label: 'Set up texting', opens: 'Settings → Texting & calls' },
      patch,
    ]);
    expect(JSON.stringify(read)).not.toContain('settings/texting');
    // Nothing to reshape when there are no issues.
    expect(teammateRead({ teammate: { name: 'Ava' } })).toEqual({ teammate: { name: 'Ava' } });
  });
});

const NEW = '11111111-1111-4111-8111-111111111111';
const BOOKED = '22222222-2222-4222-8222-222222222222';
const WON = '33333333-3333-4333-8333-333333333333';
const FUNNEL = '44444444-4444-4444-8444-444444444444';
const PIPELINE = '55555555-5555-4555-8555-555555555555';

const firstMessage = {
  id: 'mfirst01',
  when: { kind: 'arrive' as const, minutes: 0 },
  text: 'Thanks for reaching out about a tune-up.',
};
const bookMove = {
  id: 'vbook001',
  kind: 'event' as const,
  event: 'appointment.booked' as const,
  to: BOOKED,
};
const saved: FunnelDefinitionInput = {
  stages: [
    { stageId: NEW, goal: 'Get them booked', messages: [firstMessage], moves: [bookMove] },
    { stageId: BOOKED },
  ],
};

/** funnel.get's answer, as the builder reads it. */
const gotOf = (definition: FunnelDefinitionInput) => ({
  funnel: {
    id: FUNNEL,
    name: 'Spring tune-ups',
    pipelineId: PIPELINE,
    pipelineName: 'Spring',
    status: 'draft' as const,
    revision: 2,
    stages: [
      { id: NEW, name: 'New', kind: 'open' as const, position: 0, people: 1, inFunnel: true },
      { id: BOOKED, name: 'Booked', kind: 'open' as const, position: 1, people: 0, inFunnel: true },
      { id: WON, name: 'Won', kind: 'won' as const, position: 2, people: 0, inFunnel: false },
    ],
    people: 1,
    paused: 0,
    suggestions: 0,
    updatedAt: '2026-11-01T15:00:00.000Z',
    updatedBy: 'Dale Owner',
    definition: FunnelDefinition.parse(definition),
  },
  issues: [],
  forms: [],
  calendars: [],
  teammate: null,
  timeZone: 'America/Chicago',
  businessName: 'Lone Star Test HVAC',
  overlappingWorkflows: [],
  waiting: 0,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe('reading a funnel', () => {
  it('reads it whole while it fits, with who gets in and each stage in the builder’s words', () => {
    const read = funnelRead(gotOf(saved), undefined) as Loose;
    // The definition as do_funnel_save takes it back, and the revision it saves on.
    expect(read['funnel'].revision).toBe(2);
    expect(read['funnel'].definition.stages[0].messages[0].text).toBe(firstMessage.text);
    expect(read['inWords'].entry).toEqual({
      rules: [],
      addedByHand: true,
      teammateSuggests: false,
      startsAt: 'the pipeline’s first open stage',
    });
    expect(read['inWords'].stages[0]).toEqual({
      stageId: NEW,
      name: 'New',
      messages: ['mfirst01: Right away'],
      moves: ['vbook001: They book → Booked'],
    });
    expect(read['inWords'].beforeAMessageGoesOut).toContain('like the AI teammate');
  });

  it('reads one stage whole by its stageId, and says when a stage isn’t one it uses', () => {
    const read = funnelRead(gotOf(saved), NEW) as Loose;
    expect(read['funnel']).toMatchObject({ name: 'Spring tune-ups', status: 'Draft', revision: 2 });
    expect(read['stage']).toMatchObject({
      stageId: NEW,
      name: 'New',
      people: 1,
      goal: 'Get them booked',
      messages: [{ id: 'mfirst01', text: firstMessage.text }],
    });
    expect(read['stage'].inWords.messages).toEqual([
      'mfirst01: Right away: “Thanks for reaching out about a tune-up.”',
    ]);
    expect(() => funnelRead(gotOf(saved), WON)).toThrow(
      'Won is in Spring but not in Spring tune-ups yet.',
    );
    expect(() => funnelRead(gotOf(saved), FUNNEL)).toThrow('That stage isn’t in Spring.');
  });

  it('gives an outline of a funnel too long to read whole, and still reads each stage whole', () => {
    const long = (prefix: string) =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `${prefix}${i}abcd`,
        when: { kind: 'arrive' as const, minutes: i * 60 },
        text: `${i}`.repeat(1000),
      }));
    const big = gotOf({
      stages: [
        { stageId: NEW, knows: 'k'.repeat(1000), messages: long('mn') },
        { stageId: BOOKED, messages: long('mb') },
      ],
    });
    const outline = funnelRead(big, undefined) as Loose;
    expect(outline['note']).toMatch(/^This funnel is too long to read whole/);
    expect(JSON.stringify(outline).length).toBeLessThan(16_000);
    expect(outline['stages'][0].knows.length).toBeLessThanOrEqual(160);
    expect(outline['stages'][0].messages).toHaveLength(8);
    expect(outline['stages'][0].messages[1]).toMatch(/^mn1abcd: 1 hour after they arrive: “1+…”$/);
    expect(outline['stagesNotInIt']).toEqual([{ stageId: WON, name: 'Won', kind: 'won' }]);
    const stage = funnelRead(big, BOOKED) as Loose;
    expect(stage['stage'].messages.map((m: { text: string }) => m.text.length)).toEqual(
      Array(8).fill(1000),
    );
  });
});

describe('what a save changes', () => {
  it('says each change in the builder’s words, stage by stage, with no ids', () => {
    const before = FunnelDefinition.parse(saved);
    const after = FunnelDefinition.parse({
      entry: { rules: [{ id: 'rnew0001', kind: 'new_lead' }] },
      approval: 'ask',
      stages: [
        {
          stageId: NEW,
          goal: 'Book a tune-up',
          messages: [
            firstMessage,
            {
              id: 'msecond1',
              when: { kind: 'arrive', minutes: 60 },
              onlyIf: { has: false, event: 'appointment.booked' },
              wording: 'exact',
              how: 'text',
              text: 'Still want a tune-up?',
            },
          ],
          moves: [],
        },
      ],
    });
    const names = {
      stages: new Map([
        [NEW, 'New'],
        [BOOKED, 'Booked'],
        [WON, 'Won'],
      ]),
    };
    const lines = funnelChangeLines(before, after, names, 'Spring');
    expect(lines).toEqual([
      'Who gets in: adds “A new lead in Spring”',
      'New: its goal becomes “Book a tune-up”',
      'New: adds a message, 1 hour after they arrive, only if they haven’t booked, by text (exact words): “Still want a tune-up?”',
      'New: takes out the move “They book → Booked”',
      'Booked: taken out of the funnel',
      'Before a message goes out: always ask first, on Approvals',
    ]);
    for (const line of lines) expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(funnelChangeLines(before, before, names, 'Spring')).toEqual([]);
  });
});
