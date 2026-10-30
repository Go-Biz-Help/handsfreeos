/**
 * The AI asking a call's live poll questions when the team reaches them (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md,
 * part 3), without LiveKit, a model or a database: the matcher's decisions, given the call's poll and the model's
 * answer.
 *
 * What's worth holding:
 *   - only the team's words reach the model, never an attendee's;
 *   - sure pops the question up while the call lets the AI ask; fairly sure, or the AI only offering, sends "Ask now?"
 *     to the team alone, and not again for the same question straight away;
 *   - nothing reaches the model while a question is up, just after one closed, or with every question asked;
 *   - one question to the model at a time: lines heard while it thinks are looked at after.
 */
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { PollCueQuestion, PollCueState } from '@hfos/core/server';
import type { HeardLine } from '../src/video-calls/hearing';
import {
  CallPollCues,
  PollCuesOutOfRoom,
  pollCueContext,
  pollCueStep,
  type PollCueMatch,
} from '../src/video-calls/poll-cues';

const log = pino({ level: 'silent' });
const CALL = '6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b';
const PRESENTER = '0b6c4e8e-1f2a-4c3d-8e9f-0a1b2c3d4e5f';
const ATTENDEE = '5a1f0c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';

const leads: PollCueQuestion = {
  id: 'q_leads000',
  type: 'choice',
  title: 'How do you get most of your leads?',
  help: '',
  choices: ['Referrals', 'Ads', 'Website'],
  cues: ['let me ask where your leads come from'],
  state: 'waiting',
};
const book: PollCueQuestion = {
  id: 'q_book0000',
  type: 'button',
  title: 'Want a setup call?',
  help: '',
  choices: ['Book a call'],
  cues: [],
  state: 'waiting',
};

const pollState = (over: Partial<PollCueState> = {}): PollCueState => ({
  ai: 'ask',
  openNow: false,
  lastClosedAt: null,
  questions: [leads, book],
  team: [PRESENTER],
  ...over,
});

function matcher(opts: {
  state?: () => PollCueState | null;
  answer?: (lines: readonly string[]) => PollCueMatch | Promise<PollCueMatch>;
}) {
  let clock = Date.parse('2026-11-03T19:00:00Z');
  const asked: (readonly string[])[] = [];
  const opened: string[] = [];
  const offered: { questionId: string; to: readonly string[] }[] = [];
  let n = 0;
  const cues = new CallPollCues(CALL, {
    log,
    now: () => clock,
    load: async () => (opts.state ?? (() => pollState()))(),
    ask: async (_questions, lines) => {
      asked.push(lines);
      return opts.answer?.(lines) ?? { questionId: null, confidence: 'no', why: '' };
    },
    open: async (questionId) => {
      opened.push(questionId);
    },
    offer: async (message, to) => {
      offered.push({ questionId: message.questionId, to });
    },
  });
  const say = async (personId: string, text: string) => {
    const line: HeardLine = {
      key: `k${n++}`,
      personId,
      text,
      saidAt: new Date(clock).toISOString(),
      language: 'en',
    };
    cues.heard(line);
    await cues.idle();
  };
  return {
    cues,
    asked,
    opened,
    offered,
    say,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('what the AI does with an answer', () => {
  it('pops a question up when sure, offers it when fairly sure, and leaves a skipped one to the team', () => {
    const sure: PollCueMatch = { questionId: leads.id, confidence: 'sure', why: 'asked it' };
    const fairly: PollCueMatch = { ...sure, confidence: 'fairly' };
    expect(pollCueStep(pollState(), sure)).toMatchObject({ kind: 'open' });
    expect(pollCueStep(pollState(), fairly)).toMatchObject({ kind: 'offer' });
    // The call only lets the AI offer.
    expect(pollCueStep(pollState({ ai: 'suggest' }), sure)).toMatchObject({ kind: 'offer' });
    // The team skipped it: offered, never popped up.
    expect(
      pollCueStep(pollState({ questions: [{ ...leads, state: 'skipped' }] }), sure),
    ).toMatchObject({ kind: 'offer' });
    // Asked already, not in the poll, or no.
    expect(pollCueStep(pollState({ questions: [{ ...leads, state: 'closed' }] }), sure).kind).toBe(
      'none',
    );
    expect(pollCueStep(pollState(), { ...sure, questionId: 'q_madeup00' }).kind).toBe('none');
    expect(pollCueStep(pollState(), { ...sure, confidence: 'no' }).kind).toBe('none');
  });

  it('gives the model each question with its kind, choices and phrases', () => {
    const context = pollCueContext([leads, book]);
    expect(context).toContain('q_leads000 [pick one] How do you get most of your leads?');
    expect(context).toContain('Choices: Referrals; Ads; Website');
    expect(context).toContain('Said before it: “let me ask where your leads come from”');
    expect(context).toContain('q_book0000 [button] Want a setup call? Button: Book a call');
  });
});

describe('hearing the team', () => {
  it('only asks the model about the team’s words', async () => {
    const m = matcher({});
    await m.say(ATTENDEE, 'Where do you all get your leads from, I wonder?');
    expect(m.asked).toEqual([]);
    await m.say(PRESENTER, 'So let me ask you, where do most of your leads come from?');
    expect(m.asked).toEqual([['So let me ask you, where do most of your leads come from?']]);
  });

  it('pops the question up when the model is sure', async () => {
    const m = matcher({
      answer: () => ({
        questionId: leads.id,
        confidence: 'sure',
        why: 'asked where leads come from',
      }),
    });
    await m.say(PRESENTER, 'So let me ask you, where do most of your leads come from?');
    expect(m.opened).toEqual([leads.id]);
    expect(m.offered).toEqual([]);
  });

  it('offers the team "Ask now?" when fairly sure, once for a while', async () => {
    const m = matcher({
      answer: () => ({ questionId: book.id, confidence: 'fairly', why: 'talking about setup' }),
    });
    await m.say(PRESENTER, 'Setting this up takes about twenty minutes with our team.');
    expect(m.offered).toEqual([{ questionId: book.id, to: [PRESENTER] }]);
    m.tick(10_000);
    await m.say(PRESENTER, 'And we do the whole setup with you on a call.');
    expect(m.offered).toHaveLength(1);
    m.tick(150_000);
    await m.say(PRESENTER, 'Again, the setup call is free for everyone here today.');
    expect(m.offered).toHaveLength(2);
    expect(m.opened).toEqual([]);
  });

  it('stays quiet while a question is up, just after one closed, and once every question was asked', async () => {
    let state = pollState({ openNow: true });
    const m = matcher({ state: () => state });
    await m.say(PRESENTER, 'While you answer that, let me tell you about our pricing.');
    expect(m.asked).toEqual([]);

    state = pollState({ lastClosedAt: Date.parse('2026-11-03T19:00:00Z') });
    m.tick(5_000);
    await m.say(PRESENTER, 'Great answers, most of you said referrals, which is interesting.');
    expect(m.asked).toEqual([]);

    state = pollState({
      questions: [
        { ...leads, state: 'closed' },
        { ...book, state: 'closed' },
      ],
    });
    m.tick(30_000);
    await m.say(PRESENTER, 'That’s everything I wanted to ask you all today, thank you.');
    expect(m.asked).toEqual([]);
  });

  it('never reaches the model for a call with nothing to ask, or a line too short to mean anything', async () => {
    const m = matcher({ state: () => null });
    await m.say(PRESENTER, 'So let me ask you, where do most of your leads come from?');
    expect(m.asked).toEqual([]);
    const n = matcher({});
    await n.say(PRESENTER, 'Okay.');
    expect(n.asked).toEqual([]);
  });

  it('looks at lines heard while the model thinks once it answers, with the ones before them', async () => {
    let release: () => void = () => undefined;
    const m = matcher({
      answer: () =>
        new Promise<PollCueMatch>((resolve) => {
          release = () => resolve({ questionId: null, confidence: 'no', why: '' });
        }),
    });
    const line = (key: string, text: string): HeardLine => ({
      key,
      personId: PRESENTER,
      text,
      saidAt: new Date('2026-11-03T19:00:00Z').toISOString(),
      language: 'en',
    });
    m.cues.heard(line('a', 'Welcome everyone, thanks so much for joining us today.'));
    await vi.waitFor(() => expect(m.asked).toHaveLength(1));
    m.cues.heard(line('b', 'Let me ask you a quick question about your leads.'));
    expect(m.asked).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(m.asked).toHaveLength(2));
    release();
    await m.cues.idle();
    expect(m.asked[1]).toEqual([
      'Welcome everyone, thanks so much for joining us today.',
      'Let me ask you a quick question about your leads.',
    ]);
  });

  it('stops asking the model for a while once the business’s AI budget ran out', async () => {
    const m = matcher({
      answer: () => {
        throw new PollCuesOutOfRoom('The daily AI limit was reached.');
      },
    });
    await m.say(PRESENTER, 'So let me ask you, where do most of your leads come from?');
    m.tick(60_000);
    await m.say(PRESENTER, 'And how many of you use a CRM today, a show of hands?');
    expect(m.asked).toHaveLength(1);
  });
});
