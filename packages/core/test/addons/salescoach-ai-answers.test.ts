/**
 * What the Assistant reads of AI Sales Coach's answers and what its cards say (../../src/addons/salescoach/ai-answers.ts):
 * a long call's write-up kept whole ahead of what was said, the live call's stage and step ahead of its cards in place
 * of its whole playbook, the team ahead of each rep, playbooks in brief when there are too many, a draft whole and
 * ready to save, and cards that name the playbook, the suggestion or the call rather than their ids. A change to a
 * playbook keeps whatever it leaves out.
 */
import { describe, expect, it } from 'vitest';
import {
  callAnswer,
  callListAnswer,
  callResumeCard,
  callStopCard,
  draftAnswer,
  lessonCard,
  lessonOutcome,
  liveAnswer,
  playbookArchiveCard,
  playbookSaveCard,
  playbooksAnswer,
  trendsAnswer,
} from '../../src/addons/salescoach/ai-answers';
import {
  changedPlaybook,
  PlaybookSaveInput,
  type Playbook,
  type PlaybookDetails,
} from '../../src/addons/salescoach/playbooks';
import { SALESCOACH_WORDS as W } from '../../src/addons/salescoach/words';

const WS = '11111111-1111-4111-8111-111111111111';
const PB = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const REP = '44444444-4444-4444-8444-444444444444';
const PERSON = '55555555-5555-4555-8555-555555555555';

const details = (steps: number, objections: number, long = 0): PlaybookDetails => ({
  steps: Array.from({ length: steps }, (_, i) => ({
    id: `s${i + 1}`,
    title: `Step ${i + 1}`,
    say: 'w'.repeat(long),
    stage: i === 0 ? 'connect' : i === 1 ? 'problem' : null,
    tip: '',
  })),
  objections: Array.from({ length: objections }, (_, i) => ({
    id: `o${i + 1}`,
    objection: `Objection ${i + 1}`,
    answer: 'a'.repeat(long || 20),
  })),
  points: [{ id: 'p1', topic: 'Warranty', fact: 'Ten years on parts.' }],
});

const playbook = (over: Partial<Playbook> = {}): Playbook => ({
  id: PB,
  name: 'First call',
  kind: 'booked_call',
  isDefault: true,
  details: details(3, 2),
  archivedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...over,
});

describe('playbooks as the model reads them', () => {
  it('reads them whole, with each kind in the screens’ words, while they fit', () => {
    const got = playbooksAnswer({ playbooks: [playbook()] }, { workspaceId: WS }) as {
      playbooks: (Playbook & { kindLabel: string })[];
    };
    expect(got.playbooks[0]).toMatchObject({ name: 'First call', kindLabel: 'Booked call' });
    expect(got.playbooks[0]!.details.objections[0]!.answer).toBe('a'.repeat(20));
  });

  it('reads each in brief when there are too many, and one asked for by its id whole', () => {
    const many = {
      playbooks: Array.from({ length: 6 }, (_, i) =>
        playbook({ name: `Script ${i}`, details: details(10, 10, 300) }),
      ),
    };
    const brief = playbooksAnswer(many, { workspaceId: WS }) as {
      brief: boolean;
      note: string;
      playbooks: { steps: string[]; objections: string[]; talkingPoints: number }[];
    };
    expect(brief.brief).toBe(true);
    expect(brief.note).toMatch(/Pass playbookId/);
    expect(brief.playbooks).toHaveLength(6);
    expect(brief.playbooks[0]).toMatchObject({
      steps: Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`),
      objections: Array.from({ length: 10 }, (_, i) => `Objection ${i + 1}`),
      talkingPoints: 1,
    });
    expect(JSON.stringify(brief).length).toBeLessThan(16_000);
    const one = playbooksAnswer(
      { playbooks: [many.playbooks[0]] },
      { workspaceId: WS, playbookId: PB },
    ) as { playbooks: Playbook[] };
    expect(one.playbooks[0]!.details.steps[0]!.say).toBe('w'.repeat(300));
  });
});

describe('the live call as the model reads it', () => {
  const live = (step: string | null, cards = 2) => ({
    call: {
      id: CALL,
      callId: null,
      liveMeetingId: null,
      state: 'live',
      person: { id: PERSON, name: 'Dana Lee' },
      playbook: { id: PB, name: 'First call', details: details(4, 1, 2000) },
      step,
      startedAt: '2026-11-06T15:00:00.000Z',
      endedAt: null,
      cards: Array.from({ length: cards }, (_, i) => ({ id: `card-${i}`, kind: 'objection' })),
    },
  });

  it('says the stage and the step, n of m, as the screen does, in place of the whole playbook', () => {
    const got = liveAnswer(live('s3')) as {
      call: Record<string, unknown>;
      cards: unknown[];
    };
    expect(got.call['playbook']).toEqual({ id: PB, name: 'First call', steps: 4 });
    // Step 3 names no stage, so the call is still in the one before it: The problem, 2 of 2.
    expect(got.call['stage']).toEqual({ name: 'The problem', n: 2, of: 2 });
    expect(got.call['step']).toEqual({ id: 's3', title: 'Step 3', n: 3, of: 4 });
    expect(got.call['person']).toEqual({ id: PERSON, name: 'Dana Lee' });
    expect(got.cards).toHaveLength(2);
    expect(JSON.stringify(got)).not.toContain('w'.repeat(100));
    // Before the first step, it's at the start, as the screen shows it.
    const first = liveAnswer(live(null)) as { call: Record<string, unknown> };
    expect(first.call['step']).toMatchObject({ id: 's1', n: 1, of: 4 });
    expect(first.call['stage']).toEqual({ name: 'Connect', n: 1, of: 2 });
  });

  it('leaves no call as it is', () => {
    expect(liveAnswer({ call: null })).toEqual({ call: null });
  });
});

describe('a coached call as the model reads it', () => {
  it('puts the write-up ahead of what was said, from the line asked for', () => {
    const lines = Array.from({ length: 3 }, (_, i) => ({
      speaker: 'customer',
      text: `Line ${i}`,
      atMs: i,
    }));
    const got = callAnswer(
      {
        call: {
          id: CALL,
          state: 'done',
          lines,
          result: { summary: 'They want it Friday.', followUp: 'Thanks, Dana.' },
          failure: null,
          cards: [],
        },
      },
      { workspaceId: WS, coachedCallId: CALL, linesFrom: 40 },
    );
    expect(Object.keys(got as object)).toEqual([
      'call',
      'failure',
      'result',
      'cards',
      'linesFrom',
      'lines',
    ]);
    expect(got).toMatchObject({
      call: { id: CALL, state: 'done' },
      result: { followUp: 'Thanks, Dana.' },
      linesFrom: 40,
      lines,
    });
  });

  it('reads each row of the list as the list shows it, with nothing that’s empty', () => {
    const got = callListAnswer({
      calls: [
        {
          id: CALL,
          callId: PB,
          conversationId: null,
          channel: null,
          liveMeetingId: null,
          state: 'done',
          rep: { id: REP, name: 'Sam Rep' },
          person: { id: PERSON, name: 'Dana Lee' },
          playbookName: 'First call',
          startedAt: '2026-11-06T15:00:00.000Z',
          endedAt: '2026-11-06T15:20:00.000Z',
          score: 72,
          wonHow: null,
          language: 'en',
        },
      ],
    });
    // English goes without saying, as on the list; another language is said.
    expect(got).toEqual({
      calls: [
        {
          id: CALL,
          state: 'done',
          rep: 'Sam Rep',
          person: { id: PERSON, name: 'Dana Lee' },
          playbookName: 'First call',
          startedAt: '2026-11-06T15:00:00.000Z',
          score: 72,
        },
      ],
    });
  });
});

describe('trends as the model reads them', () => {
  const rep = (name: string) => ({
    rep: { id: REP, name },
    totals: { coached: 3 },
    previous: { coached: 1 },
    series: [{ week: '2026-11-02', coached: 3 }],
    skippedSteps: [],
  });
  const output = {
    weeks: ['2026-11-02'],
    timeZone: 'America/Chicago',
    reps: [rep('Sam'), rep('Kim')],
    team: { totals: { coached: 6 } },
  };

  it('puts the team first, and each rep without their weeks unless one is asked for', () => {
    const got = trendsAnswer(output, { workspaceId: WS }) as {
      reps: Record<string, unknown>[];
      note: string;
    };
    expect(Object.keys(got)).toEqual(['weeks', 'timeZone', 'team', 'note', 'reps']);
    expect(got.reps.map((r) => 'series' in r)).toEqual([false, false]);
    expect(got.reps[0]).toMatchObject({ rep: { name: 'Sam' }, totals: { coached: 3 } });
    expect(got.note).toMatch(/pass userId/);
    const one = trendsAnswer(
      { ...output, reps: [rep('Sam')] },
      { workspaceId: WS, userId: REP },
    ) as {
      reps: Record<string, unknown>[];
    };
    expect(one.reps[0]!['series']).toEqual([{ week: '2026-11-02', coached: 3 }]);
    expect('note' in one).toBe(false);
  });
});

describe('a drafted playbook as the model reads it', () => {
  it('leaves out only what a save fills back in, so it saves as it came back', () => {
    const d = details(3, 1);
    const got = draftAnswer({ name: 'New lead call', details: d }, { kind: 'cold_call' }) as {
      name: string;
      kind: string;
      details: { steps: Record<string, unknown>[] };
      saved: boolean;
    };
    expect(got).toMatchObject({ name: 'New lead call', kind: 'cold_call', saved: false });
    expect(got.details.steps[2]).toEqual({ id: 's3', title: 'Step 3' });
    // Passed to a save as it is, it's the same playbook.
    const save = PlaybookSaveInput.parse({ workspaceId: WS, name: got.name, details: got.details });
    expect(changedPlaybook(null, save.details)).toEqual(d);
    // Asked with no kind, it's the builder's first: a new lead.
    expect(draftAnswer({ name: 'x', details: d }, {})).toMatchObject({ kind: 'new_lead' });
  });
});

describe('a change to a playbook', () => {
  it('needs a name only for a new one, and keeps what a change leaves out', () => {
    const fresh = PlaybookSaveInput.safeParse({ workspaceId: WS, details: {} });
    expect(fresh.success).toBe(false);
    expect(fresh.error?.issues[0]?.message).toBe('Write the playbook’s name.');
    const usual = PlaybookSaveInput.parse({ workspaceId: WS, playbookId: PB, isDefault: true });
    expect(usual.kind).toBeUndefined();
    expect(usual.details).toBeUndefined();
    const was = details(3, 2);
    expect(changedPlaybook(was, usual.details)).toEqual(was);
    // A list given replaces that list whole; the others stay.
    const objections = [{ id: 'o9', objection: 'Too dear', answer: 'It lasts.' }];
    const changed = changedPlaybook(was, { objections });
    expect(changed.steps).toEqual(was.steps);
    expect(changed.points).toEqual(was.points);
    expect(changed.objections).toEqual([{ id: 'o1', objection: 'Too dear', answer: 'It lasts.' }]);
  });
});

describe('the cards', () => {
  it('name the playbook a save would add or change, and what it holds then', () => {
    const p = playbook();
    const add = playbookSaveCard(p, { workspaceId: WS, name: 'First call' })!;
    expect(add.title).toBe('Add the “First call” playbook?');
    expect(add.lines).toEqual(
      expect.arrayContaining([
        { label: W.playbooks.kind, value: 'Booked call' },
        { label: W.playbooks.steps, value: '3: Step 1, Step 2, Step 3' },
        { label: W.playbooks.objections, value: '2: Objection 1, Objection 2' },
        { label: W.playbooks.points, value: '1: Warranty' },
      ]),
    );
    expect(add.lines.some((l) => l.label === 'Changes')).toBe(false);
    const usual = playbookSaveCard(p, { workspaceId: WS, playbookId: PB, isDefault: true })!;
    expect(usual.title).toBe('Make “First call” the usual playbook?');
    const change = playbookSaveCard(p, {
      workspaceId: WS,
      playbookId: PB,
      details: { objections: [] },
    })!;
    expect(change.title).toBe('Change the “First call” playbook?');
    expect(change.lines[0]).toEqual({ label: 'Changes', value: W.playbooks.objections });
    expect(change.lines.length).toBeLessThanOrEqual(9);
  });

  it('name the playbook archived or brought back', () => {
    const p = playbook({ isDefault: false, archivedAt: '2026-11-06T10:00:00.000Z' });
    expect(playbookArchiveCard(p, { playbookId: PB, archived: true })!.title).toBe(
      'Archive the “First call” playbook?',
    );
    expect(playbookArchiveCard(p, { playbookId: PB, archived: false })!.title).toBe(
      'Bring back the “First call” playbook?',
    );
  });

  it('name the suggestion’s playbook and objection, with the answer now and the one suggested', () => {
    const lesson = {
      state: 'used',
      playbookName: 'First call',
      kind: 'better_answer',
      objection: 'It’s too expensive',
      current: 'We’re worth it.',
      answer: 'It lasts twice as long.',
    };
    const use = lessonCard(lesson, { lessonId: PB, use: true })!;
    expect(use.title).toBe('Use the better answer in “First call”?');
    expect(use.lines).toEqual(
      expect.arrayContaining([
        { label: W.playbooks.objection, value: 'It’s too expensive' },
        { label: W.learn.now, value: 'We’re worth it.' },
        { label: W.learn.suggested, value: 'It lasts twice as long.' },
      ]),
    );
    const added = lessonCard(
      { ...lesson, kind: 'new_objection', current: null },
      { lessonId: PB, use: true },
    )!;
    expect(added.title).toBe('Add this objection to “First call”?');
    expect(added.lines.some((l) => l.label === W.learn.now)).toBe(false);
    const no = lessonCard({ ...lesson, state: 'dismissed' }, { lessonId: PB, use: false })!;
    expect(no.title).toBe('Put away this suggestion for “First call”?');
    expect(lessonOutcome(lesson, { use: true })?.words).toBe(W.learn.used);
  });

  it('name whose call the coach stops or starts again on', () => {
    const out = {
      state: 'stopped',
      person: { id: PERSON, name: 'Dana Lee' },
      startedAt: '2026-11-06T15:00:00.000Z',
    };
    expect(callStopCard(out)!.title).toBe('Stop the coach on your call with Dana Lee?');
    expect(callResumeCard({ ...out, state: 'live' })!.title).toBe(
      'Start the coach again on your call with Dana Lee?',
    );
    expect(callStopCard({ ...out, person: null })!.title).toBe('Stop the coach on your call now?');
  });
});
