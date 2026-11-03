import { ASSISTANT_WORDS, type AssistantEvent } from '@hfos/core';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { deviceStore } from '@/lib/device-store';

import { rememberedWaiting, STILL_WORKING, useAssistantChat, type AnswerMessage } from '../chat';
import { AssistantError } from '../stream';

/**
 * Asking and leaving on the phone (`@hfos/core`'s `assistant/catch-up.ts`): the question is remembered until its
 * answer has been shown, opening Ask HandsFreeOS again reopens that chat and says it's still working until the answer
 * lands, a question left with no answer says it was cut off, and coming back to the app mid-answer checks on it in the
 * saved chat rather than trusting a stream that may not have lived through the background.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/components/ui/toast', () => ({ toast: { show: jest.fn(), error: jest.fn() } }));

type Saved = {
  thread: { id: string; title: string; lastMessageAt: string };
  messages: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    cards: [];
    createdAt: string;
  }[];
  toolCalls: [];
  answering: { runId: string; startedAt: string } | null;
};
let mockChats: Saved[] = [];
const mockLoads: string[] = [];
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual<object>('@/lib/api');
  return {
    ...actual,
    api: {
      POST: jest.fn(async (path: string, { body }: { body: { threadId?: string } }) => {
        const ok = (data: unknown) => ({ data, response: { status: 200, ok: true } });
        if (path === '/v1/queries/account.me')
          return ok({ assistantConsent: { needed: false, version: 1 } });
        if (path === '/v1/queries/assistant_thread.list')
          return ok({ items: mockChats.slice(0, 1).map((c) => c.thread) });
        if (path === '/v1/queries/assistant_thread.get') {
          mockLoads.push(body.threadId!);
          // Each check reads the next saved state of the chat; the last one stays.
          const next = mockChats.length > 1 ? mockChats.shift()! : mockChats[0]!;
          return ok(next);
        }
        throw new Error(`unexpected ${path}`);
      }),
    },
  };
});

let mockStream: (onEvent: (e: AssistantEvent) => void, signal: AbortSignal) => Promise<void>;
jest.mock('../stream', () => ({
  ...jest.requireActual<object>('../stream'),
  assistantConfigured: () => true,
  warmAssistant: jest.fn(async () => undefined),
  stopRun: jest.fn(async () => ({ stopping: false })),
  streamAnswer: (_body: unknown, onEvent: (e: AssistantEvent) => void, signal: AbortSignal) =>
    mockStream(onEvent, signal),
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const THREAD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AT = '2026-11-03T20:00:00.000Z';
const WAITING_KEY = `person.${USER}.assistantWaiting.${WS}`;

const question = {
  id: 'm1',
  role: 'user' as const,
  text: 'Who owes us?',
  cards: [] as [],
  createdAt: AT,
};
const reply = {
  id: 'm2',
  role: 'assistant' as const,
  text: 'Four invoices are waiting, $6,565.14 in all.',
  cards: [] as [],
  createdAt: AT,
};
const chat = (over: Partial<Saved> = {}): Saved => ({
  thread: { id: THREAD, title: 'Who owes us?', lastMessageAt: AT },
  messages: [question],
  toolCalls: [],
  answering: { runId: RUN, startedAt: AT },
  ...over,
});
const lastAnswer = (messages: readonly { role: string }[]) =>
  messages.filter((m): m is AnswerMessage => m.role === 'assistant').at(-1);

beforeEach(() => {
  jest.useFakeTimers();
  deviceStore.remove(WAITING_KEY);
  mockChats = [];
  mockLoads.length = 0;
  mockStream = () => new Promise(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('coming back to Ask HandsFreeOS', () => {
  it('reopens the chat a question went in, says it’s still working, and shows the answer once it lands', async () => {
    deviceStore.set(WAITING_KEY, { threadId: THREAD, askedAt: new Date().toISOString() });
    mockChats = [chat(), chat(), chat({ messages: [question, reply], answering: null })];
    const { result } = await renderHook(() => useAssistantChat(WS, USER));

    await waitFor(() => expect(result.current.threadId).toBe(THREAD));
    await waitFor(() => expect(lastAnswer(result.current.messages)?.live).toBe(true));
    expect(lastAnswer(result.current.messages)?.steps).toEqual([STILL_WORKING]);
    expect(result.current.running).toBe(true);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_100);
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Who owes us?'],
      ['assistant', 'Four invoices are waiting, $6,565.14 in all.'],
    ]);
    // Shown, so it's forgotten: the next time opens a fresh chat.
    expect(rememberedWaiting(USER, WS)).toBe(null);
  });

  it('finds a new chat’s question in the newest chat when the phone never heard which it was', async () => {
    deviceStore.set(WAITING_KEY, { threadId: null, askedAt: new Date().toISOString() });
    mockChats = [
      chat({
        thread: { id: THREAD, title: 'Who owes us?', lastMessageAt: new Date().toISOString() },
        messages: [question, reply],
        answering: null,
      }),
    ];
    const { result } = await renderHook(() => useAssistantChat(WS, USER));
    await waitFor(() => expect(result.current.threadId).toBe(THREAD));
    await waitFor(() => expect(lastAnswer(result.current.messages)?.text).toBe(reply.text));
    expect(result.current.running).toBe(false);
    expect(rememberedWaiting(USER, WS)).toBe(null);
  });

  it('says an answer that was cut off didn’t finish, with Ask again', async () => {
    deviceStore.set(WAITING_KEY, { threadId: THREAD, askedAt: new Date().toISOString() });
    mockChats = [chat({ answering: null })];
    const { result } = await renderHook(() => useAssistantChat(WS, USER));
    await waitFor(() =>
      expect(lastAnswer(result.current.messages)?.notice?.code).toBe('unfinished'),
    );
    expect(lastAnswer(result.current.messages)).toMatchObject({
      live: false,
      question: 'Who owes us?',
    });
    expect(result.current.running).toBe(false);
  });

  it('opens a fresh chat when nothing is waiting', async () => {
    const { result } = await renderHook(() => useAssistantChat(WS, USER));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(result.current.threadId).toBe(null);
    expect(result.current.messages).toEqual([]);
    expect(mockLoads).toEqual([]);
  });
});

describe('asking and leaving', () => {
  it('remembers the question until its answer is on screen', async () => {
    let send: (e: AssistantEvent) => void = () => undefined;
    let end: () => void = () => undefined;
    mockStream = (onEvent) =>
      new Promise<void>((done) => {
        send = onEvent;
        end = done;
      });
    const { result } = await renderHook(() => useAssistantChat(WS, USER));
    await waitFor(() => expect(result.current.consentNeeded).toBe(false));
    await act(async () => {
      result.current.ask('Who owes us?');
    });
    expect(rememberedWaiting(USER, WS)).toMatchObject({ threadId: null });
    await act(async () => send({ type: 'run', runId: RUN, threadId: THREAD }));
    expect(rememberedWaiting(USER, WS)).toMatchObject({ threadId: THREAD });
    await act(async () => {
      send({ type: 'text', delta: 'Four invoices.' });
      send({ type: 'done', messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
      end();
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(rememberedWaiting(USER, WS)).toBe(null);
  });

  it('checks on the answer in the saved chat when the stream drops mid-answer, instead of saying it dropped', async () => {
    let fail: (e: unknown) => void = () => undefined;
    let send: (e: AssistantEvent) => void = () => undefined;
    mockStream = (onEvent) =>
      new Promise<void>((_done, reject) => {
        send = onEvent;
        fail = reject;
      });
    mockChats = [chat(), chat({ messages: [question, reply], answering: null })];
    const { result } = await renderHook(() => useAssistantChat(WS, USER));
    await waitFor(() => expect(result.current.consentNeeded).toBe(false));
    await act(async () => {
      result.current.ask('Who owes us?');
    });
    await act(async () => send({ type: 'run', runId: RUN, threadId: THREAD }));
    await act(async () => {
      fail(new AssistantError('The connection dropped before the answer finished.', 'no_signal'));
    });
    await waitFor(() =>
      expect(lastAnswer(result.current.messages)?.steps).toContainEqual(STILL_WORKING),
    );
    expect(lastAnswer(result.current.messages)?.notice).toBe(null);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_100);
    });
    await waitFor(() => expect(lastAnswer(result.current.messages)?.text).toBe(reply.text));
    expect(result.current.running).toBe(false);
  });

  it('checks on the answer when the app comes back from the background mid-answer', async () => {
    const listeners: ((s: AppStateStatus) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (s: AppStateStatus) => void);
      return { remove: jest.fn() };
    });
    let send: (e: AssistantEvent) => void = () => undefined;
    let streamSignal: AbortSignal | null = null;
    mockStream = (onEvent, signal) => {
      send = onEvent;
      streamSignal = signal;
      return new Promise(() => undefined);
    };
    mockChats = [chat({ messages: [question, reply], answering: null })];
    const { result } = await renderHook(() => useAssistantChat(WS, USER));
    await waitFor(() => expect(result.current.consentNeeded).toBe(false));
    await act(async () => {
      result.current.ask('Who owes us?');
    });
    await act(async () => send({ type: 'run', runId: RUN, threadId: THREAD }));
    await act(async () => {
      for (const l of listeners) l('background');
    });
    await act(async () => {
      for (const l of listeners) l('active');
    });
    expect(streamSignal!.aborted).toBe(true);
    expect(lastAnswer(result.current.messages)?.steps).toContainEqual(STILL_WORKING);
    expect(ASSISTANT_WORDS.stillWorking).toBe(STILL_WORKING.label);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_100);
    });
    await waitFor(() => expect(lastAnswer(result.current.messages)?.text).toBe(reply.text));
    expect(result.current.running).toBe(false);
    spy.mockRestore();
  });
});
