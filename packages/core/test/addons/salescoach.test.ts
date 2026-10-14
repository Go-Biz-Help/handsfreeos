/**
 * AI Sales Coach's manifest and operations, held to the add-on rules (docs/addon-architecture.md), and the coach's own
 * rules (coach.ts). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import {
  cardMoment,
  checkedCard,
  checkedDraft,
  keptLines,
  KEPT_LINES,
  scoreCall,
  talkShare,
} from '../../src/addons/salescoach/coach';
import { salescoachAddon } from '../../src/addons/salescoach/manifest';
import { PlaybookDetails } from '../../src/addons/salescoach/playbooks';
import { salescoachAddonServer } from '../../src/addons/salescoach/server';

describe('AI Sales Coach', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(salescoachAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'salescoach'),
      queries: queries.filter((q) => q.addon?.id !== 'salescoach'),
    };
    expect(addonModuleIssues(core, [salescoachAddonServer])).toEqual([]);
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([salescoachAddonServer])).toEqual([]);
  });
});

describe('the coach’s rules', () => {
  const playbook = {
    steps: [
      { id: 's1', title: 'Hello', say: '' },
      { id: 's2', title: 'Book it', say: '' },
    ],
    objections: [
      { id: 'o1', objection: 'Too expensive', answer: 'The fee goes toward the repair.' },
    ],
    points: [],
  };

  it('asks for a card when the customer finishes saying something, not too often', () => {
    const said = (text: string, atMs: number, speaker: 'customer' | 'team' = 'customer') => ({
      speaker,
      text,
      atMs,
    });
    expect(cardMoment(said('That sounds really expensive', 10_000), null)).toBe(true);
    expect(cardMoment(said('Okay.', 10_000), null)).toBe(false);
    expect(cardMoment(said('Let me tell you the price', 10_000, 'team'), null)).toBe(false);
    expect(cardMoment(said('That sounds really expensive', 10_000), 8_000)).toBe(false);
    expect(cardMoment(said('That sounds really expensive', 13_000), 8_000)).toBe(true);
  });

  it('keeps a card to the playbook, and to what fits on screen', () => {
    expect(
      checkedCard(
        {
          step: 's9',
          card: {
            kind: 'objection',
            title: 'Price',
            say: 'x'.repeat(900),
            heard: 'too much',
            objectionId: 'o7',
          },
        },
        playbook,
      ),
    ).toEqual({
      step: null,
      card: {
        kind: 'objection',
        title: 'Price',
        say: `${'x'.repeat(399)}…`,
        heard: 'too much',
        objectionId: null,
      },
    });
    expect(
      checkedCard(
        { step: 's2', card: { kind: 'fact', title: ' ', say: 'x', heard: '', objectionId: null } },
        playbook,
      ),
    ).toEqual({ step: 's2', card: null });
  });

  it('scores a call from what was said, never from the model', () => {
    const lines = [
      { speaker: 'team' as const, text: 'one two three four', atMs: 0 },
      { speaker: 'customer' as const, text: 'one two three four five six', atMs: 1 },
    ];
    expect(talkShare(lines)).toBe(40);
    expect(
      scoreCall({ lines, stepsCovered: ['s1', 's1', 'zz'], steps: ['s1', 's2'], objections: [] }),
    ).toEqual({
      // Half the steps (0.5 × 0.5) and a fair share of the talking (0.2 × 1), over 0.7.
      total: 64,
      steps: { covered: 1, of: 2 },
      objections: { answered: 0, of: 0 },
      talkShare: 40,
    });
    const quiet = [{ speaker: 'customer' as const, text: 'hello there', atMs: 0 }];
    expect(scoreCall({ lines: quiet, stepsCovered: [], steps: [], objections: [] }).total).toBe(0);
  });

  it('keeps a very long call’s start and end', () => {
    const lines = Array.from({ length: KEPT_LINES + 500 }, (_, i) => ({
      speaker: 'customer' as const,
      text: `line ${i}`,
      atMs: i,
    }));
    const kept = keptLines(lines);
    expect(kept).toHaveLength(KEPT_LINES);
    expect(kept[0]!.text).toBe('line 0');
    expect(kept.at(-1)!.text).toBe(`line ${KEPT_LINES + 499}`);
    expect(keptLines(lines.slice(0, 10))).toHaveLength(10);
  });

  it('turns the AI’s playbook into one that saves', () => {
    const draft = checkedDraft(
      {
        name: '',
        steps: [
          { title: 'Hello', say: 'Hi!' },
          { title: ' ', say: 'dropped' },
        ],
        objections: [{ objection: 'Too much', answer: 'It lasts.' }],
        points: [{ topic: 'Warranty', fact: '[warranty length]' }],
      },
      'estimate',
    );
    expect(draft.name).toBe('Going over an estimate');
    expect(draft.details.steps).toEqual([{ id: 's1', title: 'Hello', say: 'Hi!' }]);
    expect(PlaybookDetails.safeParse(draft.details).success).toBe(true);
  });
});
