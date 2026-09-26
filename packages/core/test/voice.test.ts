import { describe, expect, it } from 'vitest';
import {
  AssistantAskInput,
  audioTypeOf,
  closingSpoken,
  nextSpoken,
  SPOKEN_START,
  createTurnDetector,
  heardSpeechOf,
  levelDb,
  speakable,
  SpeechSayInput,
  speechChunks,
  spokenDecision,
  spokenPart,
  takeSentences,
} from '../src/index';

/**
 * Talking out loud, the parts the web, the phone and the worker share: what's read out, how it's split so the
 * voice starts soon, a spoken yes or no to a card, and telling from the microphone's loudness when a turn ends.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('what is read out', () => {
  it('leaves markdown’s marks, links’ addresses and emoji out', () => {
    expect(
      speakable(
        '**Dale** has 3 visits today 🎉\n- 9:00 AM tune-up\n- [Open the calendar](/app/w/x/calendar)\n\nSee https://example.com',
      ),
    ).toBe('Dale has 3 visits today. 9:00 AM tune-up. Open the calendar. See.');
  });

  it('reads a table’s rows with commas and skips its dividing row', () => {
    expect(speakable('| Name | Owes |\n|---|---|\n| Ann | $40 |')).toBe('Name, Owes. Ann, $40.');
  });

  it('keeps sentences that already end', () => {
    expect(speakable('Booked it! Anything else?')).toBe('Booked it! Anything else?');
  });
});

describe('splitting what is said', () => {
  it('takes whole sentences as they arrive and keeps the rest', () => {
    expect(takeSentences('Sure. I can book that for Thu')).toEqual({
      sentences: ['Sure.'],
      rest: 'I can book that for Thu',
    });
    expect(takeSentences('First line\nSecond').sentences).toEqual(['First line']);
    expect(takeSentences('It costs $89.50 total').sentences).toEqual([]);
  });

  it('keeps the first piece short and joins the rest up to the limit', () => {
    const chunks = speechChunks('Hi there. This is Ava. How can I help? I can book a visit.', 40);
    expect(chunks[0]).toBe('Hi there.');
    expect(chunks.slice(1)).toEqual(['This is Ava. How can I help?', 'I can book a visit.']);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
  });

  it('splits one long sentence at a comma or a space', () => {
    const long = `${'word '.repeat(30)}end, and ${'more '.repeat(30)}done`;
    const chunks = speechChunks(long, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });

  it('reads at most so much of a long answer, ending on a sentence', () => {
    const answer = Array.from({ length: 20 }, (_, i) => `Customer ${i} owes money.`).join(' ');
    const part = spokenPart(answer, 100);
    expect(part.cut).toBe(true);
    expect(part.text.length).toBeLessThanOrEqual(100);
    expect(part.text.endsWith('.')).toBe(true);
    expect(spokenPart('Short one.')).toEqual({ text: 'Short one.', cut: false });
  });
});

describe('reading an answer out as it arrives', () => {
  it('says whole sentences as they come, then the rest once it’s finished', () => {
    let step = nextSpoken(SPOKEN_START, 'You have **3 visits** today. The first is', false);
    expect(step.say).toEqual(['You have 3 visits today.']);
    step = nextSpoken(step.state, 'You have **3 visits** today. The first is at 9 AM', false);
    expect(step.say).toEqual([]);
    step = nextSpoken(step.state, 'You have **3 visits** today. The first is at 9 AM', true);
    expect(step.say).toEqual(['The first is at 9 AM.']);
    expect(
      nextSpoken(step.state, 'You have **3 visits** today. The first is at 9 AM', true).say,
    ).toEqual([]);
  });

  it('stops on a whole sentence past the limit, and says the rest is on the screen', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    const step = nextSpoken(SPOKEN_START, text, true, 32);
    expect(step.say).toEqual(['One two three.', 'Four five six.']);
    expect(step.state.cut).toBe(true);
    expect(closingSpoken({ state: step.state, notice: null, waiting: [] })).toEqual([
      'There’s more on the screen.',
    ]);
  });

  it('asks for a yes or a no when one card waits', () => {
    const said = { taken: 10, said: 10, cut: false };
    expect(
      closingSpoken({
        state: said,
        notice: null,
        waiting: [{ title: 'Text Mike', needsReason: false }],
      }),
    ).toEqual(['Should I go ahead? Say yes or no.']);
    expect(
      closingSpoken({
        state: SPOKEN_START,
        notice: null,
        waiting: [{ title: 'Text Mike', needsReason: false }],
      }),
    ).toEqual(['Text Mike. Should I go ahead? Say yes or no.']);
    expect(
      closingSpoken({ state: said, notice: null, waiting: [{ title: 'Lost', needsReason: true }] }),
    ).toEqual(['Pick a reason on the card, then confirm it.']);
    expect(
      closingSpoken({
        state: said,
        notice: 'The connection dropped.',
        waiting: [
          { title: 'A', needsReason: false },
          { title: 'B', needsReason: false },
        ],
      }),
    ).toEqual([
      'The connection dropped.',
      'Check the cards on the screen, or ask me something else.',
    ]);
  });
});

describe('a spoken yes or no', () => {
  it.each([
    'Yes',
    'yeah go ahead',
    'OK',
    'Sure, do it.',
    'Yes please',
    'Sounds good',
    'Send it',
    'Sí, por favor',
  ])('“%s” is a yes', (said) => expect(spokenDecision(said)).toBe('yes'));

  it.each(['No', 'no thanks', 'Cancel it', 'Don’t do that', 'Not now', 'Hold off'])(
    '“%s” is a no',
    (said) => expect(spokenDecision(said)).toBe('no'),
  );

  it.each([
    'Yes, but make it 3 PM',
    'What time is it?',
    'No, go ahead',
    'Book Dale for Friday morning instead please',
    '',
  ])('“%s” is neither', (said) => expect(spokenDecision(said)).toBeNull());
});

describe('telling when a turn ends', () => {
  /** Feeds a level every 50 ms for `ms`, and returns the last state. */
  function run(d: ReturnType<typeof createTurnDetector>, from: number, ms: number, db: number) {
    let state = d.feed(db, from);
    for (let t = from + 50; t <= from + ms; t += 50) state = d.feed(db, t);
    return state;
  }

  it('waits through the room’s noise, hears talking, and ends after a pause', () => {
    const d = createTurnDetector({ silenceMs: 1000, speechMs: 150 });
    expect(run(d, 0, 500, -60)).toBe('waiting');
    expect(run(d, 550, 800, -25)).toBe('talking');
    expect(d.heard).toBe(true);
    expect(run(d, 1400, 900, -60)).toBe('talking');
    expect(run(d, 2350, 200, -60)).toBe('done');
  });

  it('a click isn’t talking', () => {
    const d = createTurnDetector({ speechMs: 200 });
    run(d, 0, 300, -60);
    d.feed(-20, 350);
    expect(run(d, 400, 2000, -60)).toBe('waiting');
    expect(d.heard).toBe(false);
  });

  it('a loud room raises the bar', () => {
    const d = createTurnDetector({ marginDb: 12 });
    expect(run(d, 0, 1600, -35)).toBe('waiting');
    expect(run(d, 1650, 500, -28)).toBe('waiting');
    expect(run(d, 2200, 500, -15)).toBe('talking');
  });

  it('hears someone who starts talking the moment it listens', () => {
    const d = createTurnDetector({ speechMs: 150, silenceMs: 1000 });
    expect(run(d, 0, 500, -20)).toBe('talking');
    expect(run(d, 550, 1100, -60)).toBe('done');
  });

  it('something quieter than talking at the start waits for the room to be known', () => {
    const d = createTurnDetector({ speechMs: 150 });
    expect(run(d, 0, 400, -40)).toBe('waiting');
    run(d, 450, 150, -65);
    expect(run(d, 650, 400, -40)).toBe('talking');
  });

  it('gives up when nothing is said, and sends a very long turn anyway', () => {
    const quiet = createTurnDetector({ waitMs: 3000 });
    expect(run(quiet, 0, 3000, -70)).toBe('nothing');
    // Words with short gaps between them, for longer than a turn may last.
    const long = createTurnDetector({ maxMs: 5000 });
    let state = long.feed(-70, 0);
    for (let t = 50; t <= 5000; t += 50) state = long.feed(t % 400 < 300 ? -20 : -70, t);
    expect(state).toBe('done');
    expect(long.heard).toBe(true);
  });

  it('reads samples as dBFS', () => {
    expect(levelDb([1, -1, 1, -1])).toBeCloseTo(0);
    expect(levelDb([0.1, -0.1])).toBeCloseTo(-20);
    expect(levelDb([0, 0])).toBe(-120);
  });
});

describe('the worker’s side', () => {
  it('says a clip in the teammate’s voice unless one is named', () => {
    expect(SpeechSayInput.parse({ workspaceId: WS, text: ' Hi ' })).toEqual({
      workspaceId: WS,
      text: 'Hi',
      voice: null,
      language: null,
    });
    expect(SpeechSayInput.safeParse({ workspaceId: WS, text: 'Hi', voice: 'loud' }).success).toBe(
      false,
    );
    expect(SpeechSayInput.safeParse({ workspaceId: WS, text: 'x'.repeat(1001) }).success).toBe(
      false,
    );
  });

  it('reads a recording’s type and what was heard', () => {
    expect(audioTypeOf('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(audioTypeOf('Audio/MP4')).toBe('audio/mp4');
    expect(audioTypeOf('application/json')).toBeNull();
    expect(audioTypeOf(undefined)).toBeNull();
    expect(heardSpeechOf({ text: ' Hi ', language: 'en' })).toEqual({ text: 'Hi', language: 'en' });
    expect(heardSpeechOf(null)).toEqual({ text: '', language: null });
  });

  it('a question asked out loud says so', () => {
    expect(AssistantAskInput.parse({ workspaceId: WS, text: 'Hi' }).spoken).toBe(false);
    expect(AssistantAskInput.parse({ workspaceId: WS, text: 'Hi', spoken: true }).spoken).toBe(
      true,
    );
  });
});
