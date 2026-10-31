/**
 * AI Sales Coach's manifest and operations, held to the add-on rules (docs/addon-architecture.md), and the coach's own
 * rules (coach.ts). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonAssistantIssues,
  addonModuleIssues,
  allAddonAiTools,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import {
  BRIEF_GUESS_ASK,
  briefGuessPrompt,
  cardMoment,
  checkedBrief,
  checkedCard,
  callerScript,
  checkedDraft,
  COACH_SYSTEM,
  nudgeAllowed,
  NUDGE_EVERY_MS,
  keptLines,
  KEPT_LINES,
  PLAYBOOK_DRAFT_ASK,
  PLAYBOOK_DRAFT_SYSTEM,
  playbookDraftPrompt,
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
import {
  AI_CALLER_STAGES,
  BUILDER_KINDS,
  CALL_OPENINGS,
  callKindFor,
  NEW_LEAD_DAYS,
  playbookStages,
  SALES_BRIEF_MAX,
  SALES_BRIEF_QUESTIONS,
  SALES_STAGES,
  stageAt,
} from '../../src/addons/salescoach/method';
import { blankBrief, PLAYBOOK_KINDS, PlaybookDetails } from '../../src/addons/salescoach/playbooks';
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
    expect(addonAssistantIssues([salescoachAddonServer])).toEqual([]);
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
  const playbook = PlaybookDetails.parse({
    steps: [
      { id: 's1', title: 'Hello', say: '' },
      { id: 's2', title: 'Book it', say: '' },
    ],
    objections: [
      { id: 'o1', objection: 'Too expensive', answer: 'The fee goes toward the repair.' },
    ],
    points: [],
  });

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
            tip: 'Slow down',
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
        tip: 'Slow down',
        objectionId: null,
      },
    });
    expect(
      checkedCard(
        {
          step: 's2',
          card: { kind: 'fact', title: ' ', say: 'x', heard: '', tip: '', objectionId: null },
        },
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
      stages: null,
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
    expect(draft.details.steps).toEqual([
      { id: 's1', title: 'Hello', say: 'Hi!', stage: null, tip: '' },
    ]);
    expect(PlaybookDetails.safeParse(draft.details).success).toBe(true);
  });

  it('keeps the stage the AI gives each step, when it’s one of the method’s', () => {
    const draft = checkedDraft(
      {
        name: 'New lead',
        steps: [
          {
            title: 'Ask what they use now',
            say: 'What are you using now?',
            stage: 'situation',
            tip: '',
          },
          {
            title: 'Ask what’s wrong',
            say: 'What do you mean by that?',
            stage: 'problem',
            tip: 'Slow down.',
          },
          { title: 'Odd one', say: '', stage: 'hard_sell', tip: '' },
          // An older stand-in leaves both out.
          { title: 'Book it', say: '' },
        ],
        objections: [],
        points: [],
      },
      'new_lead',
    );
    expect(draft.details.steps.map((st) => [st.id, st.stage, st.tip])).toEqual([
      ['s1', 'situation', ''],
      ['s2', 'problem', 'Slow down.'],
      ['s3', null, ''],
      ['s4', null, ''],
    ]);
    // A playbook saved before stages reads as having none.
    expect(PlaybookDetails.parse({ steps: [{ id: 's1', title: 'Hello' }] }).steps[0]).toEqual({
      id: 's1',
      title: 'Hello',
      say: '',
      stage: null,
      tip: '',
    });
  });
});

describe('the question-led method', () => {
  it('asks the AI to write each kind of call its own way, from the owner’s answers', () => {
    const prompt = playbookDraftPrompt({
      kind: 'aged_lead',
      business: '<business_profile>\nLone Star HVAC\n</business_profile>',
      script: null,
      brief: { ...blankBrief(), offer: 'AC repair', problems: 'Rooms that won’t cool' },
    });
    expect(prompt).toContain('Older lead');
    expect(prompt).toContain(CALL_OPENINGS.aged_lead);
    expect(prompt).toContain('<owner_answers>');
    expect(prompt).toContain('AC repair');
    // A blank answer isn't asked about.
    expect(prompt).not.toContain(SALES_BRIEF_QUESTIONS.why.ask);
    expect(prompt.endsWith(PLAYBOOK_DRAFT_ASK)).toBe(true);
    // No answers at all: no empty block.
    expect(
      playbookDraftPrompt({ kind: 'new_lead', business: '', script: null, brief: blankBrief() }),
    ).not.toContain('<owner_answers>');
  });

  it('tells the AI the stages and what it never does', () => {
    for (const st of SALES_STAGES) expect(PLAYBOOK_DRAFT_SYSTEM).toContain(`- ${st} (`);
    expect(PLAYBOOK_DRAFT_SYSTEM).toMatch(/Never mislead/);
    expect(PLAYBOOK_DRAFT_SYSTEM).toMatch(/Never invent deadlines/);
    expect(PLAYBOOK_DRAFT_SYSTEM).toMatch(/Never suggest they borrow/);
    // The method is in HandsFreeOS's own words: it names no outside program.
    expect(`${PLAYBOOK_DRAFT_SYSTEM}${COACH_SYSTEM}`).not.toMatch(/NEPQ|7th Level/i);
  });

  it('has an opening for every kind of call, and builds the four new ones', () => {
    for (const k of PLAYBOOK_KINDS) expect(CALL_OPENINGS[k]).toBeTruthy();
    expect(BUILDER_KINDS.every((k) => PLAYBOOK_KINDS.includes(k))).toBe(true);
  });

  it('keeps what the AI already knows of the builder’s questions to their length', () => {
    const brief = checkedBrief({
      ...blankBrief(),
      offer: `  AC   repair ${'x'.repeat(500)}`,
      buyers: 'Homeowners',
    });
    expect(brief.offer.length).toBe(SALES_BRIEF_MAX);
    expect(brief.offer.startsWith('AC repair')).toBe(true);
    expect(brief.buyers).toBe('Homeowners');
    expect(brief.why).toBe('');
    expect(briefGuessPrompt('<knowledge>\n</knowledge>').endsWith(BRIEF_GUESS_ASK)).toBe(true);
  });
});

describe('coaching by stage', () => {
  const staged = [
    { id: 's1', stage: 'connect' as const },
    { id: 's2', stage: 'problem' as const },
    { id: 's3', stage: null },
    { id: 's4', stage: 'present' as const },
  ];

  it('knows the stages a script goes through, and the one the call is in', () => {
    expect(playbookStages(staged)).toEqual(['connect', 'problem', 'present']);
    expect(playbookStages([{ id: 's1', stage: null }])).toEqual([]);
    expect(stageAt(staged, 's2')).toBe('problem');
    // A step without a stage carries on the one before.
    expect(stageAt(staged, 's3')).toBe('problem');
    expect(stageAt(staged, null)).toBeNull();
    expect(stageAt(staged, 'zz')).toBeNull();
  });

  it('opens with the script for how the call started', () => {
    const call = {
      meeting: false,
      direction: 'outbound' as const,
      booked: false,
      known: true,
      leadAgeDays: null,
    };
    expect(callKindFor({ ...call, meeting: true, direction: null })).toBe('booked_call');
    expect(callKindFor({ ...call, booked: true, leadAgeDays: 40 })).toBe('booked_call');
    expect(callKindFor({ ...call, leadAgeDays: 2 })).toBe('new_lead');
    expect(callKindFor({ ...call, leadAgeDays: NEW_LEAD_DAYS })).toBe('new_lead');
    expect(callKindFor({ ...call, leadAgeDays: NEW_LEAD_DAYS + 1 })).toBe('aged_lead');
    expect(callKindFor({ ...call, known: false })).toBe('cold_call');
    // A customer with no open lead, or a call the customer made: the usual script.
    expect(callKindFor(call)).toBeNull();
    expect(callKindFor({ ...call, direction: 'inbound', leadAgeDays: 2 })).toBeNull();
  });

  it('coaches the method live, with tips and nudges', () => {
    expect(COACH_SYSTEM).toContain('Never invent deadlines');
    expect(COACH_SYSTEM).toContain('consequence (If nothing changes)');
    expect(COACH_SYSTEM).toContain('nudge:');
    expect(COACH_SYSTEM).toContain('tip:');
    expect(COACH_SYSTEM).not.toMatch(/NEPQ|7th Level/i);
  });

  it('nudges once for the same thing, and not too often', () => {
    const none = { lastAtMs: null, titles: new Set<string>() };
    expect(nudgeAllowed(none, 'Price before the problem', 5_000)).toBe(true);
    const one = { lastAtMs: 5_000, titles: new Set(['price before the problem']) };
    expect(nudgeAllowed(one, ' Price before the problem ', 500_000)).toBe(false);
    expect(nudgeAllowed(one, 'Let them talk', 5_000 + NUDGE_EVERY_MS - 1)).toBe(false);
    expect(nudgeAllowed(one, 'Let them talk', 5_000 + NUDGE_EVERY_MS)).toBe(true);
  });

  it('scores a script with stages by stage, less when the offer came too soon', () => {
    const lines = [
      { speaker: 'team' as const, text: 'one two three four', atMs: 0 },
      { speaker: 'customer' as const, text: 'one two three four five six', atMs: 1 },
    ];
    const score = scoreCall({ lines, stepsCovered: ['s1', 's3'], steps: staged, objections: [] });
    // Connect only (s3 carries no stage of its own): 1 of 3 stages (0.5 × ⅓) and the talking (0.2 × 1), over 0.7.
    expect(score).toMatchObject({
      total: 52,
      steps: { covered: 2, of: 4 },
      stages: { covered: ['connect'], missed: ['problem', 'present'], pitchedEarly: false },
    });
    const all = ['s1', 's2', 's4'];
    expect(scoreCall({ lines, stepsCovered: all, steps: staged, objections: [] }).total).toBe(100);
    const early = scoreCall({
      lines,
      stepsCovered: all,
      steps: staged,
      objections: [],
      pitchedEarly: true,
    });
    // Three quarters of the stages' part: (0.5 × 0.75 + 0.2) / 0.7.
    expect(early.total).toBe(82);
    expect(early.stages?.pitchedEarly).toBe(true);
  });
});

describe('the AI teammate’s calls to leads (round five, part three)', () => {
  const step = (id: string, stage: (typeof SALES_STAGES)[number] | null, say = '', tip = '') => ({
    id,
    title: `Step ${id}`,
    say,
    tip,
    stage,
  });

  it('asks the script’s questions up to how much it matters, and stops there', () => {
    expect(AI_CALLER_STAGES.at(-1)).toBe('importance');
    expect(AI_CALLER_STAGES).not.toContain('present');
    const script = callerScript(
      'New leads',
      'new_lead',
      PlaybookDetails.parse({
        steps: [
          step('s1', 'connect', 'Is now an OK time?'),
          step('s2', 'problem', 'What made you look into this?', 'Slow down here.'),
          step('s3', null, 'How long has that been going on?'),
          step('s4', 'importance', 'How important is it to you to fix that?'),
          step('s5', 'present', 'Here is how we fix it.'),
          step('s6', 'commit', 'Shall we get you started?'),
        ],
        objections: [
          { id: 'o1', objection: 'Too expensive', answer: 'Too expensive compared to what?' },
        ],
      }),
    )!;
    expect(script).toContain('Script: New leads (New lead who asked us to call)');
    expect(script).toContain(CALL_OPENINGS.new_lead);
    expect(script).toContain('1. (Connect) Say: “Is now an OK time?”');
    expect(script).toContain(
      '2. (The problem) Say: “What made you look into this?” How: Slow down here.',
    );
    // A step without a stage carries on the one before it.
    expect(script).toContain('3. (The problem) Say: “How long has that been going on?”');
    expect(script).toContain('How important is it to you to fix that?');
    expect(script).not.toContain('Here is how we fix it.');
    expect(script).not.toContain('Shall we get you started?');
    expect(script).toContain('“Too expensive” → Too expensive compared to what?');
  });

  it('keeps a script without stages whole, and says where to stop', () => {
    const script = callerScript(
      'Our own',
      'any',
      PlaybookDetails.parse({
        steps: [step('s1', null, 'Hi there.'), step('s2', null), step('s3', null, 'Want to buy?')],
      }),
    )!;
    expect(script).toContain(
      'stop before any step that shows the offer, gives a price or asks for the sale',
    );
    expect(script).toContain('2. Step s2');
    expect(script).toContain('Want to buy?');
    expect(script).not.toContain('Objections');
  });

  it('has nothing to follow without questions before the offer', () => {
    expect(callerScript('Empty', 'any', PlaybookDetails.parse({ steps: [] }))).toBeNull();
    expect(
      callerScript(
        'Only the pitch',
        'any',
        PlaybookDetails.parse({ steps: [step('s1', 'present', 'Here it is.')] }),
      ),
    ).toBeNull();
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
