import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CATCH_UP,
  ASSISTANT_WAITING_KEEP_MS,
  ASSISTANT_WORDS,
  assistantAnswerAfterLastQuestion,
  assistantChatToReopen,
  assistantNotice,
  assistantQuestionUnanswered,
  assistantWaitingOf,
  waitForAssistantAnswer,
} from '../src/index';

/**
 * Asking and leaving (assistant/catch-up.ts): what the web's panel and the phone's Ask HandsFreeOS screen remember
 * while an answer is out, which chat they reopen when the person comes back, how they check on an answer still
 * coming, and what they put on screen once it lands.
 */

const NOW = Date.parse('2026-11-03T20:00:00.000Z');
const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const iso = (ms: number) => new Date(ms).toISOString();

describe('the question remembered while its answer is out', () => {
  it('is kept for a day, with or without its chat', () => {
    const asked = iso(NOW - 60_000);
    expect(assistantWaitingOf({ threadId: THREAD, askedAt: asked }, NOW)).toEqual({
      threadId: THREAD,
      askedAt: asked,
    });
    expect(assistantWaitingOf({ threadId: null, askedAt: asked }, NOW)).toEqual({
      threadId: null,
      askedAt: asked,
    });
    expect(
      assistantWaitingOf(
        { threadId: THREAD, askedAt: iso(NOW - ASSISTANT_WAITING_KEEP_MS - 1) },
        NOW,
      ),
    ).toBe(null);
  });

  it('drops anything else that was stored', () => {
    expect(assistantWaitingOf(null, NOW)).toBe(null);
    expect(assistantWaitingOf('nope', NOW)).toBe(null);
    expect(assistantWaitingOf({ threadId: THREAD }, NOW)).toBe(null);
    expect(assistantWaitingOf({ threadId: 7, askedAt: iso(NOW) }, NOW)).toBe(null);
    expect(assistantWaitingOf({ threadId: THREAD, askedAt: 'yesterday' }, NOW)).toBe(null);
    // From a clock far ahead of this one.
    expect(assistantWaitingOf({ threadId: THREAD, askedAt: iso(NOW + 3_600_000) }, NOW)).toBe(null);
  });
});

describe('the chat reopened on coming back', () => {
  const waiting = { threadId: null, askedAt: iso(NOW - 120_000) };

  it('is the question’s own chat when it’s known', () => {
    expect(assistantChatToReopen({ ...waiting, threadId: THREAD }, null)).toBe(THREAD);
  });

  it('is the newest chat for a new chat’s question, if it was touched since it was asked', () => {
    expect(assistantChatToReopen(waiting, { id: THREAD, lastMessageAt: iso(NOW - 119_000) })).toBe(
      THREAD,
    );
    // The worker's clock a little behind this one's.
    expect(assistantChatToReopen(waiting, { id: THREAD, lastMessageAt: iso(NOW - 150_000) })).toBe(
      THREAD,
    );
    // An older chat isn't the one it went in.
    expect(
      assistantChatToReopen(waiting, { id: THREAD, lastMessageAt: iso(NOW - 3_600_000) }),
    ).toBe(null);
    expect(assistantChatToReopen(waiting, null)).toBe(null);
  });
});

describe('checking on an answer still coming', () => {
  const answering = { runId: RUN, startedAt: iso(NOW) };

  /** A clock that moves only when the check waits, and a record of each wait. */
  function clock() {
    let at = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => at,
      wait: async (ms: number) => {
        waits.push(ms);
        at += ms;
      },
    };
  }

  it('checks until nothing is answering, and answers with the chat then', async () => {
    const c = clock();
    const reads = [{ answering }, { answering }, { answering: null, n: 3 }];
    let i = 0;
    const got = await waitForAssistantAnswer(async () => reads[i++]!, {
      signal: new AbortController().signal,
      now: c.now,
      wait: c.wait,
    });
    expect(got).toEqual({ answering: null, n: 3 });
    expect(c.waits).toEqual([2_000, 2_000, 2_000]);
  });

  it('waits before the first check when it already has the chat, and answers at once when it’s done', async () => {
    type Chat = { answering: typeof answering | null; already?: boolean };
    const c = clock();
    const loaded: number[] = [];
    const got = await waitForAssistantAnswer<Chat>(
      async () => {
        loaded.push(c.now());
        return { answering: null };
      },
      { signal: new AbortController().signal, first: { answering }, now: c.now, wait: c.wait },
    );
    expect(got).toEqual({ answering: null });
    expect(loaded).toEqual([2_000]);
    const done = await waitForAssistantAnswer<Chat>(async () => ({ answering }), {
      signal: new AbortController().signal,
      first: { answering: null, already: true },
      now: c.now,
      wait: c.wait,
    });
    expect(done).toEqual({ answering: null, already: true });
  });

  it('checks less often after a minute, tries again after a failed check, and gives up after ten', async () => {
    const c = clock();
    let calls = 0;
    const got = await waitForAssistantAnswer(
      async () => {
        calls++;
        if (calls === 2) throw new TypeError('Network request failed');
        return { answering };
      },
      { signal: new AbortController().signal, now: c.now, wait: c.wait },
    );
    expect(got).toBe(null);
    expect(c.waits.slice(0, 30).every((ms) => ms === ASSISTANT_CATCH_UP.everyMs)).toBe(true);
    expect(c.waits.at(-1)).toBe(ASSISTANT_CATCH_UP.slowEveryMs);
    expect(c.now()).toBeGreaterThanOrEqual(ASSISTANT_CATCH_UP.giveUpAfterMs);
  });

  it('stops when told to', async () => {
    const stop = new AbortController();
    const got = await waitForAssistantAnswer(
      async () => {
        stop.abort();
        return { answering };
      },
      { signal: stop.signal, wait: async () => undefined },
    );
    expect(got).toBe(null);
  });
});

describe('what goes on screen once it lands', () => {
  it('is everything after the chat’s last question', () => {
    const chat = [
      { role: 'user' as const, text: 'How many leads?' },
      { role: 'assistant' as const, text: 'Three.' },
      { role: 'user' as const, text: 'And yesterday?' },
      { role: 'assistant' as const, text: 'Two.' },
    ];
    expect(assistantAnswerAfterLastQuestion(chat)).toEqual([{ role: 'assistant', text: 'Two.' }]);
    expect(assistantAnswerAfterLastQuestion(chat.slice(0, 3))).toEqual([]);
    expect(assistantAnswerAfterLastQuestion([])).toEqual([]);
  });

  it('says a question with no answer and nothing answering it was cut off, with Try again', () => {
    const asked = [{ role: 'user' as const }];
    expect(assistantQuestionUnanswered(asked, null)).toBe(true);
    expect(assistantQuestionUnanswered(asked, { runId: RUN })).toBe(false);
    expect(assistantQuestionUnanswered([...asked, { role: 'assistant' as const }], null)).toBe(
      false,
    );
    expect(assistantQuestionUnanswered([], null)).toBe(false);
    expect(assistantNotice('unfinished', { workspaceName: 'Lone Star HVAC', message: '' })).toEqual(
      {
        icon: 'alert',
        tone: 'neutral',
        title: 'This answer didn’t finish',
        sub: 'It was cut off before it was done. Try again and it starts over.',
        action: 'retry',
      },
    );
  });

  it('says it’s still working while it checks, and that leaving is fine', () => {
    expect(ASSISTANT_WORDS.stillWorking).toMatch(/still working/i);
    expect(ASSISTANT_WORDS.hintWhileAnswering).toMatch(/you can leave/i);
  });
});
