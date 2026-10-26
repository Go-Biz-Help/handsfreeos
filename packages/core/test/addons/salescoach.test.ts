/**
 * AI Sales Coach's manifest and operations, held to the add-on rules (docs/addon-architecture.md), and the coach's own
 * rules (coach.ts). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  allAddonAiTools,
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
import {
  checkedLessons,
  lessonWords,
  newInWins,
  tallyObjections,
} from '../../src/addons/salescoach/learn';
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
  it('gives the Assistant what a person does, but never deleting a call', () => {
    const ops = [
      ...(salescoachAddonServer.queries ?? []),
      ...(salescoachAddonServer.commands ?? []),
    ];
    const tools = new Map(allAddonAiTools([salescoachAddonServer]).map((t) => [t.op.name, t]));
    const people = ops.filter((op) => (op.actors ?? ['human']).includes('human'));
    // Deleting a coached call is for good, and risk 4: never the AI's (Chris, 2026-10-16).
    expect(people.filter((op) => !tools.has(op.name)).map((op) => op.name)).toEqual([
      'salescoach.call.delete',
    ]);
    expect(ops.filter((op) => !people.includes(op) && tools.has(op.name))).toEqual([]);
    // Putting a card away is the only change it makes on its own: the rest change a playbook or stop a call.
    expect(
      [...tools.values()]
        .filter((t) => t.op.kind === 'command' && t.autonomy === 'auto')
        .map((t) => t.op.name),
    ).toEqual(['salescoach.card.dismiss']);
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

describe('learning from wins', () => {
  const book = {
    steps: [],
    objections: [
      { id: 'o1', objection: 'It’s too expensive', answer: 'It’s worth it.' },
      { id: 'o2', objection: 'I need to ask my wife', answer: 'Of course.' },
    ],
    points: [],
  };
  const heard = (objectionId: string | null, answer: string, said = 'Too much money') => ({
    said,
    answered: true,
    answer,
    objectionId,
  });
  const records = [
    { id: 'a', won: true, objections: [heard('o1', 'The fee goes toward the repair.')] },
    { id: 'b', won: true, objections: [heard('o1', 'It’s credited toward the repair.')] },
    { id: 'c', won: true, objections: [heard('o1', 'You only pay once for the visit.')] },
    { id: 'd', won: false, objections: [heard('o1', 'It’s worth it.')] },
    { id: 'e', won: true, objections: [heard('o2', 'Want me to text her the details?')] },
    {
      id: 'f',
      won: true,
      objections: [heard(null, 'We can start Monday.', 'How soon can you start?')],
    },
    { id: 'g', won: true, objections: [heard(null, 'Monday works.', 'How soon can you start?')] },
  ];

  it('tallies each playbook objection’s wins, and what wins said that the playbook lacks', () => {
    const t = tallyObjections(records, book);
    expect(t.find((x) => x.objectionId === 'o1')).toMatchObject({ of: 4, wins: 3 });
    expect(t.find((x) => x.objectionId === 'o1')!.winningAnswers).toHaveLength(3);
    expect(t.find((x) => x.objectionId === 'o2')).toMatchObject({ of: 1, wins: 1 });
    expect(newInWins(records).map((f) => f.record)).toEqual(['f', 'g']);
  });

  it('keeps only lessons the numbers back up', () => {
    const t = tallyObjections(records, book);
    const fresh = newInWins(records);
    const lessons = checkedLessons(
      {
        better: [
          { objectionId: 'o1', answer: 'I hear you. The visit fee goes toward the repair.' },
          // Too few wins, a made-up id, and what the playbook already says: all dropped.
          { objectionId: 'o2', answer: 'Want me to text her?' },
          { objectionId: 'o9', answer: 'Nope.' },
        ],
        added: [
          { objection: 'How soon can you start?', answer: 'We can start Monday.', wins: [1, 2] },
          { objection: 'Do you do roofs?', answer: 'Yes.', wins: [1, 1] },
        ],
      },
      book,
      t,
      fresh,
    );
    expect(lessons).toEqual([
      expect.objectContaining({ kind: 'better_answer', objectionId: 'o1', wins: 3, of: 4 }),
      expect.objectContaining({
        kind: 'new_objection',
        objection: 'How soon can you start?',
        wins: 2,
        evidence: ['f', 'g'],
      }),
    ]);
    expect(lessonWords(lessons[0]!)).toBe(
      'Came up 4 times, and 3 ended in a win. This is how the reps answered when they won.',
    );
  });
});
