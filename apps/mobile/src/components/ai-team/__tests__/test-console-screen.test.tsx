import type { TestConsoleBody, TestEvent } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import type * as TestStream from '@/ai-team/test-stream';
import { useTestConsole } from '@/ai-team/use-test-console';

import { TestConsoleView, type TestCustomer } from '../test-console';

/**
 * The phone's test console with React Native Testing Library, the worker played by a stand-in stream: a written test
 * shows the reply and what it looked up; an incoming call starts with the greeting and a goodbye ends it; an outgoing
 * call needs a customer, and sends which way it goes and why; with no signal it says so and keeps the words; and
 * talking out loud says each reply in the teammate's voice and sends what the caller says.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

type Answer = (body: TestConsoleBody) => readonly TestEvent[];
const mockAnswer = jest.fn<readonly TestEvent[], [TestConsoleBody]>();
const mockBodies: TestConsoleBody[] = [];
let mockOffline = false;
/** While set, a caller's reply's `done` waits for it: what's said before is said while it's still written. */
let mockBeforeDone: Promise<void> | null = null;
jest.mock('@/ai-team/test-stream', () => {
  const actual = jest.requireActual('@/ai-team/test-stream') as typeof TestStream;
  return {
    ...actual,
    streamTest: async (body: TestConsoleBody, onEvent: (e: TestEvent) => void) => {
      mockBodies.push(body);
      if (mockOffline) throw new actual.TestConsoleError(actual.NO_SIGNAL, 'no_signal');
      for (const e of mockAnswer(body)) {
        if (e.type === 'done' && body.messages.length && mockBeforeDone) await mockBeforeDone;
        onEvent(e);
      }
    },
  };
});

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
const audio = jest.requireMock('expo-audio') as {
  __recorder: { meter: (ms: number) => number };
  __played: string[];
};

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OMAR: TestCustomer = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Omar Haddad',
  searchText: 'omar haddad',
};
const AT = '2026-09-25T15:00:00.000Z';
const done = (
  reply: string,
  over: Partial<Extract<TestEvent, { type: 'done' }>> = {},
): TestEvent => ({
  type: 'done',
  outcome: 'replied',
  reply,
  draft: false,
  ended: false,
  toolSteps: 1,
  ms: 900,
  firstWordsMs: null,
  ...over,
});

function Harness({ pane = 'chat' }: { pane?: 'chat' | 'log' }) {
  const state = useTestConsole(WS, 'Ava');
  return (
    <TestConsoleView
      state={state}
      name="Ava"
      timeZone="America/Chicago"
      customers={[OMAR]}
      pane={pane}
    />
  );
}

const answer = (fn: Answer) => mockAnswer.mockImplementation(fn);

beforeEach(() => {
  mockAnswer.mockReset();
  mockBodies.length = 0;
  mockOffline = false;
});

describe('a written test', () => {
  it('shows the reply, and what it looked up on the log', async () => {
    answer(() => [
      { type: 'knowledge', query: 'price', items: [{ id: 'k', title: 'Prices' }], at: AT },
      { type: 'delta', text: 'A visit is $89.' },
      done('A visit is $89.', { draft: true, outcome: 'drafted' }),
    ]);
    const { rerender } = await render(<Harness />);
    await fireEvent.changeText(screen.getByTestId('test-console-input'), 'How much is a visit?');
    await fireEvent.press(screen.getByTestId('test-console-send'));
    await waitFor(() =>
      expect(screen.getByTestId('test-console-reply')).toHaveTextContent('A visit is $89.'),
    );
    expect(screen.getByText('Draft (training wheels)')).toBeTruthy();
    expect(mockBodies[0]).toMatchObject({
      workspaceId: WS,
      channel: 'sms',
      call: null,
      personId: null,
      config: null,
      messages: [{ from: 'customer', text: 'How much is a visit?' }],
    });
    await rerender(<Harness pane="log" />);
    expect(screen.getByTestId('test-console-log')).toBeTruthy();
  });
});

describe('a test call', () => {
  const choose = async (testID: string) => {
    await fireEvent.press(screen.getByTestId('test-console-setup'));
    await fireEvent.press(await screen.findByTestId(testID));
  };

  it('picks up with the greeting, and a goodbye hangs up', async () => {
    answer((body) =>
      body.messages.length
        ? [done('Thanks for calling. Bye now!', { ended: true })]
        : [
            { type: 'delta', text: 'Thanks for calling Lone Star.' },
            done('Thanks for calling Lone Star.'),
          ],
    );
    await render(<Harness />);
    await choose('test-channel-phone');
    expect(screen.queryByTestId('test-console-input')).toBeNull();
    await fireEvent.press(screen.getByTestId('test-console-start-call'));
    await waitFor(() =>
      expect(screen.getAllByTestId('test-console-reply')[0]).toHaveTextContent(
        'Thanks for calling Lone Star.',
      ),
    );
    expect(mockBodies[0]).toMatchObject({
      channel: 'phone',
      call: { direction: 'inbound', purpose: null, goal: null },
      messages: [],
    });

    await fireEvent.changeText(screen.getByTestId('test-console-input'), 'That’s all, bye!');
    await fireEvent.press(screen.getByTestId('test-console-send'));
    await waitFor(() => expect(screen.getByTestId('test-console-call-over')).toBeTruthy());
    expect(mockBodies[1]!.messages).toEqual([
      { from: 'teammate', text: 'Thanks for calling Lone Star.' },
      { from: 'customer', text: 'That’s all, bye!' },
    ]);
    expect(screen.getByText('Hung up')).toBeTruthy();
    expect(screen.queryByTestId('test-console-input')).toBeNull();
  });

  it('calls out only to someone in Customers, and says why it calls', async () => {
    answer(() => [done('Hi Omar, this is Ava. I’m calling about your tune-up.')]);
    await render(<Harness />);
    await choose('test-channel-phone');
    await fireEvent.press(screen.getByTestId('test-call-outbound'));
    expect(screen.getByTestId('test-console-start-call')).toBeDisabled();
    expect(screen.getAllByText('Pick a customer for Ava to call.').length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByTestId(`test-as-${OMAR.id}`));
    await fireEvent.press(screen.getByTestId('test-call-why-quote'));
    await fireEvent.press(screen.getByTestId('test-console-start-call'));
    await waitFor(() => expect(mockBodies).toHaveLength(1));
    expect(mockBodies[0]).toMatchObject({
      personId: OMAR.id,
      channel: 'phone',
      call: { direction: 'outbound', purpose: 'quote', goal: null },
    });
    expect(screen.getByTestId('test-console-how')).toHaveTextContent(
      'Outgoing call · follow up a quote · Now',
    );
  });

  it('talks out loud: says the greeting in its voice, hears the caller, and answers out loud', async () => {
    answer((body) =>
      body.messages.length
        ? [done('Thursday at 10 works. Shall I book it?')]
        : [done('Thanks for calling Lone Star.')],
    );
    // Talking for half a second, then quiet: one turn each time it listens.
    audio.__recorder.meter = (ms) => (ms > 100 && ms < 600 ? -20 : -60);
    mockHear.mockResolvedValue({ text: 'Can I book Thursday?', language: 'en' });
    let clips = 0;
    mockSay.mockImplementation(async () => `file:///cache/clip-${++clips}.mp3`);
    await render(<Harness />);
    await choose('test-channel-phone');
    await fireEvent.press(screen.getByTestId('test-console-talk'));
    await waitFor(() => expect(screen.getByTestId('voice-bar')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('test-console-start-call'));
    await waitFor(() => expect(mockBodies).toHaveLength(2), { timeout: 8000 });
    expect(mockSay.mock.calls[0]![0]).toMatchObject({
      workspaceId: WS,
      text: 'Thanks for calling Lone Star.',
      voice: null,
    });
    expect(audio.__played[0]).toBe('file:///cache/clip-1.mp3');
    expect(mockBodies[1]!.messages).toEqual([
      { from: 'teammate', text: 'Thanks for calling Lone Star.' },
      { from: 'customer', text: 'Can I book Thursday?' },
    ]);
    await waitFor(() =>
      expect(screen.getAllByTestId('test-console-reply')[1]).toHaveTextContent(
        'Thursday at 10 works. Shall I book it?',
      ),
    );
    await waitFor(() =>
      expect(mockSay.mock.calls.map((c) => (c[0] as { text: string }).text)).toContain(
        'Thursday at 10 works.',
      ),
    );

    await fireEvent.press(screen.getByTestId('voice-stop'));
    await waitFor(() => expect(screen.queryByTestId('voice-bar')).toBeNull());
  }, 20_000);

  it('talks out loud while the reply is written, then says only the rest', async () => {
    answer((body) =>
      body.messages.length
        ? [
            { type: 'say', text: 'Thursday at 10 works.' },
            done('Thursday at 10 works. Shall I book it?', { firstWordsMs: 400 }),
          ]
        : [done('Thanks for calling Lone Star.')],
    );
    audio.__recorder.meter = (ms) => (ms > 100 && ms < 600 ? -20 : -60);
    mockHear.mockResolvedValue({ text: 'Can I book Thursday?', language: 'en' });
    mockSay.mockReset();
    let clips = 0;
    mockSay.mockImplementation(async () => `file:///cache/clip-${++clips}.mp3`);
    const said = () => mockSay.mock.calls.map((c) => (c[0] as { text: string }).text);
    await render(<Harness />);
    await choose('test-channel-phone');
    await fireEvent.press(screen.getByTestId('test-console-talk'));
    await waitFor(() => expect(screen.getByTestId('voice-bar')).toBeTruthy());

    let release = () => {};
    mockBeforeDone = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await fireEvent.press(screen.getByTestId('test-console-start-call'));
      await waitFor(() => expect(mockBodies).toHaveLength(2), { timeout: 8000 });
      // The reply isn't done, and its first sentence is already being said.
      await waitFor(() => expect(said()).toContain('Thursday at 10 works.'));
      expect(said()).not.toContain('Shall I book it?');
    } finally {
      mockBeforeDone = null;
      release();
    }
    await waitFor(() => expect(said()).toContain('Shall I book it?'));
    expect(said()).not.toContain('Thursday at 10 works. Shall I book it?');

    await fireEvent.press(screen.getByTestId('voice-stop'));
    await waitFor(() => expect(screen.queryByTestId('voice-bar')).toBeNull());
  }, 20_000);

  it('says it needs signal, and keeps what was written', async () => {
    mockOffline = true;
    await render(<Harness />);
    await fireEvent.changeText(screen.getByTestId('test-console-input'), 'Hello?');
    await fireEvent.press(screen.getByTestId('test-console-send'));
    await waitFor(() =>
      expect(screen.getByTestId('test-console-off')).toHaveTextContent(
        'The test console needs signal.',
      ),
    );
    expect(screen.getByTestId('test-console-input').props.value).toBe('Hello?');
  });
});
