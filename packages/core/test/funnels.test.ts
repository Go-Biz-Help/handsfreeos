/**
 * Teammate funnels without a database (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): what a definition
 * accepts, when its messages are due, trying it as a lead, what stops it from going on, the blanks an exact message
 * fills, the AI's draft, and the words.
 */
import { describe, expect, it } from 'vitest';
import { localInstant } from '../src/calendar/engine/zoned';
import {
  definitionFromDraft,
  fillFunnelText,
  funnelBlanks,
  funnelBlocker,
  funnelDurationWords,
  FunnelDefinition,
  FunnelDraft,
  funnelEntryWords,
  funnelIssues,
  funnelMessageDueAt,
  funnelMessageStale,
  funnelMoveWords,
  funnelOnlyIfWords,
  funnelTimelineWords,
  funnelUnknownBlanks,
  funnelUpcoming,
  funnelWhenShort,
  funnelWhenWords,
  matchDraftStages,
  playFunnel,
  type FunnelIssueContext,
} from '../src/funnels/index';
import { christinaFunnel, RECRUITING_STAGES, type RecruitingKey } from './funnel-fixtures';

const TZ = 'America/Chicago';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = Object.fromEntries(RECRUITING_STAGES.map((s, i) => [s.key, uuid(i + 1)])) as Record<
  RecruitingKey,
  string
>;
const stages = RECRUITING_STAGES.map((s, i) => ({
  id: id[s.key],
  name: s.name,
  kind: s.kind,
  position: i + 1,
}));
const names = { stages: new Map(stages.map((s) => [s.id, s.name])) };
const closed = new Set(stages.filter((s) => s.kind !== 'open').map((s) => s.id));
const def = christinaFunnel(id);
const stageOf = (key: RecruitingKey) => def.stages.find((s) => s.stageId === id[key])!;
const messageOf = (key: RecruitingKey, messageId: string) =>
  stageOf(key).messages.find((m) => m.id === messageId)!;

/** Thursday, October 29, 2026 at 7:00 PM in Chicago: the presentation. */
const SESSION = localInstant('2026-10-29', '19:00', TZ);

describe('a funnel’s definition', () => {
  it('fills in what was left out', () => {
    const d = FunnelDefinition.parse({ stages: [{ stageId: id.new }] });
    expect(d).toMatchObject({
      v: 1,
      wording: 'ai',
      approval: 'teammate',
      entry: { rules: [], byHand: true, aiSuggests: false, startStageId: null },
      stages: [{ goal: '', knows: '', moves: [], messages: [], handOff: false }],
    });
    expect(christinaFunnel(id).stages[0]!.messages[0]).toMatchObject({
      onlyIf: null,
      how: 'best',
      goodForMinutes: null,
    });
  });

  it('refuses a stage twice, two parts with one id, and a move to its own stage', () => {
    const twice = FunnelDefinition.safeParse({
      stages: [{ stageId: id.new }, { stageId: id.new }],
    });
    expect(twice.success).toBe(false);
    const shared = FunnelDefinition.safeParse({
      stages: [
        {
          stageId: id.new,
          moves: [{ id: 'vsame', kind: 'quiet', minutes: 60, to: id.out }],
          messages: [{ id: 'vsame', when: { kind: 'arrive', minutes: 0 }, text: 'Hi' }],
        },
        { stageId: id.out },
      ],
    });
    expect(shared.success).toBe(false);
    const loop = FunnelDefinition.safeParse({
      stages: [
        { stageId: id.new, moves: [{ id: 'vloop', kind: 'quiet', minutes: 60, to: id.new }] },
      ],
    });
    expect(loop.success).toBe(false);
  });

  it('keeps its limits: quiet moves from an hour to 90 days, and a time like 16:00', () => {
    const quiet = (minutes: number) =>
      FunnelDefinition.safeParse({
        stages: [
          { stageId: id.new, moves: [{ id: 'vquiet', kind: 'quiet', minutes, to: id.out }] },
          { stageId: id.out },
        ],
      }).success;
    expect(quiet(59)).toBe(false);
    expect(quiet(60)).toBe(true);
    expect(quiet(90 * 24 * 60 + 1)).toBe(false);
    const at = (clock: string) =>
      FunnelDefinition.safeParse({
        stages: [
          {
            stageId: id.booked,
            messages: [
              { id: 'mclock', when: { kind: 'booking_day', daysBefore: 1, at: clock }, text: 'Hi' },
            ],
          },
        ],
      }).success;
    expect(at('16:00')).toBe(true);
    expect(at('4pm')).toBe(false);
  });
});

describe('when its messages are due', () => {
  const reachedAt = SESSION - 2 * DAY;
  const clock = { reachedAt, booking: { startsAt: SESSION }, timeZone: TZ };

  it('counts from arriving, from the booking’s start, or from its day at a set time where the business is', () => {
    expect(funnelMessageDueAt(messageOf('missed', 'mpick2'), clock)).toBe(reachedAt + 2 * DAY);
    expect(funnelMessageDueAt(messageOf('booked', 'mhour'), clock)).toBe(SESSION - HOUR);
    expect(funnelMessageDueAt(messageOf('booked', 'mlogon'), clock)).toBe(SESSION + 5 * MIN);
    expect(funnelMessageDueAt(messageOf('booked', 'mdaybefore'), clock)).toBe(
      localInstant('2026-10-28', '18:00', TZ),
    );
  });

  it('has nothing to time by without a booking', () => {
    expect(
      funnelMessageDueAt(messageOf('booked', 'mhour'), { ...clock, booking: null }),
    ).toBeNull();
    expect(
      funnelMessageDueAt(messageOf('booked', 'mdaybefore'), { ...clock, booking: null }),
    ).toBeNull();
  });

  it('goes stale past its good-until: half an hour around a start, two hours on its day, a day otherwise', () => {
    const logon = messageOf('booked', 'mlogon');
    const due = SESSION + 5 * MIN;
    expect(funnelMessageStale(logon, due, due + 29 * MIN)).toBe(false);
    expect(funnelMessageStale(logon, due, due + 31 * MIN)).toBe(true);
    const day = messageOf('booked', 'mdaybefore');
    expect(funnelMessageStale(day, 0, 2 * HOUR + MIN)).toBe(true);
    expect(funnelMessageStale(messageOf('missed', 'mpick'), 0, 23 * HOUR)).toBe(false);
  });

  it('lists what’s still to come, soonest first, without what went or what’s ruled out', () => {
    const now = SESSION - 3 * HOUR;
    const next = funnelUpcoming(stageOf('booked'), { ...clock, sent: [], seen: [], now });
    expect(next.map((n) => n.message.id)).toEqual(['mhour', 'mlogon']);
    // The day-before reminder was due at 6:00 PM yesterday: past its two hours, so it's dropped.
    const joined = funnelUpcoming(stageOf('booked'), {
      ...clock,
      sent: ['mhour'],
      seen: ['attendee.joined'],
      now,
    });
    expect(joined).toEqual([]);
    // Booked 50 minutes ahead: the hour-before reminder goes as they arrive, but not the day-before one.
    const late = funnelUpcoming(stageOf('booked'), {
      ...clock,
      reachedAt: SESSION - 50 * MIN,
      sent: [],
      seen: [],
      now: SESSION - 50 * MIN,
    });
    expect(late.map((n) => [n.message.id, n.dueAt])).toEqual([
      ['mhour', SESSION - 50 * MIN],
      ['mlogon', SESSION + 5 * MIN],
    ]);
  });
});

describe('trying it as a lead', () => {
  const play = (choices: string[]) =>
    playFunnel({
      definition: def,
      names,
      closedStageIds: closed,
      startStageId: id.new,
      startAt: SESSION - 3 * DAY,
      bookingAt: SESSION,
      timeZone: TZ,
      choices,
    });

  it('stops at the first fork and lists what can move them on', () => {
    const p = play([]);
    expect(p.stageId).toBe(id.new);
    expect(p.entries.map((e) => e.kind)).toEqual(['arrive', 'message']);
    expect(p.fork).toEqual({
      stageId: id.new,
      options: [{ moveId: 'vopened', label: 'they send a form', to: id.funnel }],
    });
  });

  it('walks the path picked: joined skips “Were you able to log on?”', () => {
    const p = play(['vopened', 'vbooked', 'vjoined']);
    expect(p.stageId).toBe(id.at);
    const atBooked = p.entries.filter((e) => 'stageId' in e && e.stageId === id.booked);
    expect(
      atBooked.map((e) =>
        e.kind === 'message' || e.kind === 'skipped' ? `${e.kind}:${e.messageId}` : e.kind,
      ),
    ).toEqual(['arrive', 'message:mdaybefore', 'message:mhour', 'skipped:mlogon']);
    expect(p.entries.find((e) => e.kind === 'did' && e.moveId === 'vjoined')).toMatchObject({
      label: 'they join',
    });
  });

  it('a no-show gets the log-on nudge, then the pick-another-night messages', () => {
    const p = play(['vopened', 'vbooked', 'vnoshow']);
    expect(p.stageId).toBe(id.missed);
    const messages = p.entries.flatMap((e) => (e.kind === 'message' ? [e.messageId] : []));
    expect(messages).toEqual(['mlink', 'mdaybefore', 'mhour', 'mlogon', 'mpick', 'mpick2']);
    expect(
      p.entries.filter((e) => e.kind === 'message' && e.messageId === 'mpick2')[0],
    ).toMatchObject({
      maybe: false,
    });
  });

  it('ends at a won stage, with the hand-off on the way', () => {
    const p = play(['vopened', 'vbooked', 'vjoined', 'vended', 'vyes', 'vthree']);
    expect(p.fork).toBeNull();
    expect(p.stageId).toBe(id.call);
    expect(p.entries.some((e) => e.kind === 'handoff' && e.stageId === id.interested)).toBe(true);
    expect(p.entries[p.entries.length - 1]).toMatchObject({ kind: 'end', stageId: id.call });
  });
});

describe('what stops it from going on', () => {
  const context = (over: Partial<FunnelIssueContext> = {}): FunnelIssueContext => ({
    pipelineName: 'Recruiting',
    stages,
    teammate: { name: 'Ava', status: 'automatic', approved: 20, needed: 20 },
    overlappingWorkflows: [],
    ...over,
  });

  it('is ready with a teammate on, its stages in the pipeline, and a way in', () => {
    const issues = funnelIssues(def, context());
    expect(funnelBlocker(issues)).toBeNull();
    expect(issues.filter((i) => i.level === 'ok').map((i) => i.rule)).toEqual([
      'goals',
      'rules',
      'join_link',
    ]);
  });

  it('needs the teammate on', () => {
    expect(funnelBlocker(funnelIssues(def, context({ teammate: null })))?.rule).toBe('no_teammate');
    const off = funnelBlocker(
      funnelIssues(
        def,
        context({ teammate: { name: 'Ava', status: 'off', approved: 0, needed: 20 } }),
      ),
    );
    expect(off).toMatchObject({
      rule: 'teammate_off',
      words: expect.stringContaining('Turn Ava on'),
    });
  });

  it('says which stage is gone, and when nobody can get in', () => {
    const gone = funnelIssues(def, context({ stages: stages.filter((s) => s.id !== id.missed) }));
    expect(funnelBlocker(gone)?.rule).toBe('stage_gone');
    const shut = christinaFunnel(id, { entry: { rules: [], byHand: false, aiSuggests: false } });
    expect(funnelIssues(shut, context()).map((i) => i.rule)).toContain('no_way_in');
  });

  it('warns about training wheels and a workflow texting the same leads', () => {
    const issues = funnelIssues(
      christinaFunnel(id, { approval: 'teammate' }),
      context({
        teammate: { name: 'Ava', status: 'training', approved: 3, needed: 20 },
        overlappingWorkflows: ['New lead text'],
      }),
    );
    expect(funnelBlocker(issues)).toBeNull();
    expect(issues.filter((i) => i.level === 'yellow').map((i) => i.words)).toEqual([
      'Ava is in training wheels (3 of 20 approved), so each message waits for an OK until then.',
      'New lead text also texts new leads in Recruiting, so they’d hear from both.',
    ]);
  });
});

describe('an exact message’s blanks', () => {
  it('fills what it knows, and still reads without it', () => {
    const text = 'Hi {first_name}! See you at {session_time}. Your link: {join_link}';
    expect(funnelBlanks(text)).toEqual(['first_name', 'session_time', 'join_link']);
    expect(
      fillFunnelText(text, {
        first_name: 'Sam',
        session_time: '7:00 PM',
        join_link: 'https://hfos.app/j/abc',
      }),
    ).toBe('Hi Sam! See you at 7:00 PM. Your link: https://hfos.app/j/abc');
    expect(fillFunnelText('Hi {first_name}, thanks from {business}!', {})).toBe(
      'Hi there, thanks from us!',
    );
  });

  it('points out a blank it doesn’t know', () => {
    expect(funnelUnknownBlanks('Hi {firstname}, it’s {first_name}')).toEqual(['firstname']);
    expect(fillFunnelText('Hi {firstname}', { first_name: 'Sam' })).toBe('Hi {firstname}');
  });
});

describe('the AI’s draft', () => {
  const draft = FunnelDraft.parse({
    name: 'Recruiting',
    stages: [
      {
        name: 'New lead',
        kind: 'open',
        goal: 'Get them to open their link',
        moves: [{ kind: 'event', event: 'form.submitted', to: 'Booked' }],
        messages: [{ when: { kind: 'arrive', minutes: 0 }, text: 'Send their link.' }],
      },
      {
        name: 'Booked',
        kind: 'open',
        moves: [{ kind: 'quiet', minutes: 1440, to: 'Gone quiet' }],
      },
      { name: 'Gone quiet', kind: 'lost' },
    ],
    entry: { rules: [{ kind: 'new_lead' }], startStage: 'New lead' },
  });

  it('matches its stages to the pipeline’s by name, and drops what has no stage', () => {
    const map = matchDraftStages(draft, stages);
    expect([...map.values()]).toEqual([id.new, id.booked]);
    map.set('gone quiet', id.out);
    const d = definitionFromDraft(draft, map, 'How Christina recruits');
    expect(d.stages.map((s) => s.stageId)).toEqual([id.new, id.booked, id.out]);
    expect(d.stages[0]!.moves[0]).toMatchObject({ kind: 'event', to: id.booked });
    expect(d.stages[0]!.messages[0]!.id).toMatch(/^m[a-z0-9]{7}$/);
    expect(d.entry).toMatchObject({ startStageId: id.new, rules: [{ kind: 'new_lead' }] });
    expect(d.description).toBe('How Christina recruits');
    // Without a stage for "Gone quiet", the move to it goes too.
    const partial = definitionFromDraft(draft, matchDraftStages(draft, stages));
    expect(partial.stages.find((s) => s.stageId === id.booked)!.moves).toEqual([]);
  });
});

describe('the words', () => {
  it('says how long and when', () => {
    expect(funnelDurationWords(5)).toBe('5 minutes');
    expect(funnelDurationWords(90)).toBe('1 hour 30 minutes');
    expect(funnelDurationWords(3 * 24 * 60)).toBe('3 days');
    expect(funnelDurationWords(7 * 24 * 60)).toBe('1 week');
    expect(funnelWhenWords({ kind: 'arrive', minutes: 0 })).toBe('Right away');
    expect(funnelWhenWords({ kind: 'booking', minutes: -60 })).toBe('1 hour before it starts');
    expect(funnelWhenWords({ kind: 'booking_day', daysBefore: 1, at: '16:00' })).toBe(
      'The day before, at 4:00 PM',
    );
    expect(funnelWhenShort({ kind: 'booking', minutes: 5 })).toBe('5 min in');
    expect(funnelOnlyIfWords({ has: false, event: 'attendee.joined' })).toBe(
      'Only if they haven’t joined',
    );
  });

  it('labels a move and a way in', () => {
    expect(funnelMoveWords(stageOf('funnel').moves[1]!, names)).toBe('3 days quiet → Out');
    expect(funnelMoveWords(stageOf('after').moves[0]!, names)).toBe(
      'They say they’re interested → Interested',
    );
    expect(
      funnelEntryWords({ id: 'rway', kind: 'came_in', ways: ['facebook_lead_ad'] }, 'Recruiting'),
    ).toMatch(/^A new lead from a /);
  });

  it('says on the timeline what was done', () => {
    expect(funnelTimelineWords('funnel_joined', { funnel: 'Recruiting', stage: 'New lead' })).toBe(
      'put them in Recruiting at New lead',
    );
    expect(funnelTimelineWords('funnel_left', { funnel: 'Recruiting', reason: 'won' })).toBe(
      'took them out of Recruiting: they reached a won stage',
    );
    expect(funnelTimelineWords('funnel_left', { funnel: 'Recruiting', reason: 'removed' })).toBe(
      'took them out of Recruiting',
    );
    expect(
      funnelTimelineWords('funnel_paused', { funnel: 'Recruiting', reason: 'taken_over' }),
    ).toBe('paused Recruiting for them: someone on the team is talking to them');
    expect(funnelTimelineWords('funnel_resumed', { funnel: 'Recruiting' })).toBe(
      'picked Recruiting back up for them',
    );
    expect(funnelTimelineWords('stage_changed', {})).toBeNull();
  });
});
