import type { AssistantCard } from '@hfos/core';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { AnswerMessage, AssistantChat, CallState, ChatMessage } from '../chat';
import { useAssistantVoice } from '../voice';

/**
 * Ask HandsFreeOS out loud on the phone, with the stand-in microphone and speaker (jest.setup.ts), the worker's
 * speech played by stand-ins, and a chat the test drives: what's said is asked (marked spoken), the answer is read
 * out a sentence at a time as it arrives and then it listens again; and a plain "yes" to a card waiting for an OK
 * confirms it and says how it went, without asking anything new.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const mockHear = jest.fn();
const mockSay = jest.fn();
jest.mock('@/voice/speech', () => {
  const actual = jest.requireActual('@/voice/speech');
  return {
    ...actual,
    hear: (...args: unknown[]) => mockHear(...args),
    say: (...args: unknown[]) => mockSay(...args),
    forget: jest.fn(),
  };
});

const mockConfirm = jest.fn();
jest.mock('../stream', () => {
  const actual = jest.requireActual('../stream');
  return {
    ...actual,
    confirmToolCall: (...args: unknown[]) => mockConfirm(...args),
    cancelToolCall: jest.fn(),
  };
});

const audio = jest.requireMock('expo-audio') as { __recorder: { meter: (ms: number) => number } };

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-25T15:00:00.000Z';

function chatWith(messages: ChatMessage[], over: Partial<AssistantChat> = {}): AssistantChat {
  return {
    messages,
    calls: {},
    threadId: null,
    running: false,
    loading: false,
    setup: 'ready',
    paused: false,
    online: true,
    consentNeeded: false,
    giveConsent: jest.fn(),
    ask: jest.fn(() => true),
    retry: jest.fn(),
    stop: jest.fn(),
    newChat: jest.fn(),
    openThread: jest.fn(),
    setCall: jest.fn(),
    forgetThread: jest.fn(),
    ...over,
  };
}

const answer = (text: string, live: boolean, cards: AssistantCard[] = []): AnswerMessage => ({
  key: 'a-1',
  role: 'assistant',
  text,
  cards,
  steps: [],
  live,
  notice: null,
  question: 'What’s on today?',
  createdAt: NOW,
});
const said = () => mockSay.mock.calls.map((c) => (c[0] as { text: string }).text);

beforeEach(() => {
  mockHear.mockReset();
  mockSay.mockReset();
  mockConfirm.mockReset();
  let clips = 0;
  mockSay.mockImplementation(async () => `file:///cache/clip-${++clips}.mp3`);
  // Talking for half a second, then quiet: one turn each time it listens.
  audio.__recorder.meter = (ms) => (ms > 100 && ms < 600 ? -20 : -60);
});

it('asks what was said, reads the answer as it arrives, and listens again', async () => {
  mockHear.mockResolvedValue({ text: 'What’s on today?', language: 'en' });
  const empty = chatWith([]);
  const { result, rerender } = await renderHook(
    ({ chat }: { chat: AssistantChat }) => useAssistantVoice(chat, WS),
    { initialProps: { chat: empty } },
  );
  await act(() => result.current.toggle());
  await waitFor(
    () => expect(empty.ask).toHaveBeenCalledWith('What’s on today?', { spoken: true }),
    {
      timeout: 5000,
    },
  );

  const question: ChatMessage = {
    key: 'q-1',
    role: 'user',
    text: 'What’s on today?',
    createdAt: NOW,
  };
  await rerender({
    chat: chatWith([question, answer('You have **3 visits** today. The first', true)], {
      running: true,
    }),
  });
  await waitFor(() => expect(said()).toEqual(['You have 3 visits today.']));
  await rerender({
    chat: chatWith([question, answer('You have **3 visits** today. The first is at 9 AM.', false)]),
  });
  await waitFor(() =>
    expect(said()).toEqual(['You have 3 visits today.', 'The first is at 9 AM.']),
  );
  // Then it listens for the next question by itself.
  await waitFor(() => expect(mockHear).toHaveBeenCalledTimes(2), { timeout: 5000 });
  await act(() => result.current.toggle());
  expect(result.current.snap.phase).toBe('off');
}, 20_000);

it('a plain yes confirms the card waiting for an OK, and says how it went', async () => {
  const card = {
    type: 'confirm',
    toolCallId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tool: 'send_text',
    title: 'Text Mike Johnson',
    fields: [],
    body: 'Hi Mike, running 10 minutes late.',
    warnings: [],
    reasons: [],
    confirmLabel: 'Send text',
    editable: true,
  } as unknown as AssistantCard;
  const calls: Record<string, CallState> = {};
  const setCall = jest.fn((id: string, patch: Partial<CallState>) => {
    calls[id] = { ...calls[id], ...patch } as CallState;
  });
  const chat = chatWith([answer('I drafted the text to Mike.', false, [card])], { setCall });
  mockHear.mockResolvedValueOnce({ text: 'Yes, go ahead.', language: 'en' });
  mockHear.mockResolvedValue({ text: '', language: null });
  mockConfirm.mockResolvedValue({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tool: 'send_text',
    status: 'confirmed',
    outcome: 'Texted Mike Johnson.',
    href: null,
    error: null,
  });
  const { result } = await renderHook(() => useAssistantVoice(chat, WS));
  await act(() => result.current.toggle());
  await waitFor(() => expect(mockConfirm).toHaveBeenCalled(), { timeout: 5000 });
  expect(mockConfirm).toHaveBeenCalledWith('cccccccc-cccc-4ccc-8ccc-cccccccccccc', WS, undefined);
  expect(chat.ask).not.toHaveBeenCalled();
  expect(calls['cccccccc-cccc-4ccc-8ccc-cccccccccccc']).toMatchObject({ status: 'confirmed' });
  await waitFor(() => expect(said()).toEqual(['Texted Mike Johnson.']));
  await act(() => result.current.toggle());
}, 20_000);
