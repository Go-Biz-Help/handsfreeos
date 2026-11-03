import type { TeammateFeedbackOut, TestConsoleBody, TestEvent } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import type * as TestStream from '@/ai-team/test-stream';
import { useTestConsole } from '@/ai-team/use-test-console';
import { change } from '@/changes';
import { api } from '@/lib/api';

import { TestConsoleView, type TestCustomer } from '../test-console';

/**
 * The phone's test console with React Native Testing Library, the worker played by a stand-in stream: a written test
 * shows the reply and what it looked up; an incoming call starts with the greeting and a goodbye ends it; an outgoing
 * call needs a customer, and sends which way it goes and why; with no signal it says so and keeps the words;
 * talking out loud says each reply in the teammate's voice and sends what the caller says; a call can try another
 * voice, hear it and keep it; and a reply takes a thumbs down on its run, and "Retry with the fix" runs that turn
 * again with it.
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
const mockSayClip = jest.fn();
const mockReadiness = jest.fn();
jest.mock('@/voice/speech', () => {
  const actual = jest.requireActual('@/voice/speech');
  return {
    ...actual,
    hear: (...args: unknown[]) => mockHear(...args),
    say: (...args: unknown[]) => mockSay(...args),
    sayClip: (...args: unknown[]) => mockSayClip(...args),
    voiceReadiness: () => mockReadiness(),
    forget: jest.fn(),
  };
});
// Feedback on a reply goes to HandsFreeOS: its commands and the feedback query, played by stand-ins.
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return { change: jest.fn(), ChangeError: actual.ChangeError, NEEDS_SIGNAL: actual.NEEDS_SIGNAL };
});
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  unwrap: (result: { data?: unknown }) => result.data,
}));
let mockFeedback: TeammateFeedbackOut[] = [];

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
  steps: null,
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
  mockFeedback = [];
  jest.mocked(api.POST as unknown as jest.Mock).mockImplementation(async () => ({
    data: { feedback: mockFeedback, messageRuns: [], canSaveRules: true },
    response: { ok: true },
  }));
  jest.mocked(change).mockReset();
  mockReadiness.mockResolvedValue({ deepgram: true, rime: true });
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

  it('takes a thumbs down on a reply, and tries that turn again with the fix', async () => {
    const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const runs = [
      RUN,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ];
    answer((body) => {
      const reply = body.coaching
        ? 'We’re closed Sundays. Does Monday at 10 work?'
        : body.messages.length > 1
          ? 'You’re welcome!'
          : 'Sure, we can come Sunday at 10.';
      return [{ type: 'started', runId: runs[mockBodies.length - 1]!, at: AT }, done(reply)];
    });
    const { rerender } = await render(<Harness />);
    const write = async (words: string) => {
      await fireEvent.changeText(screen.getByTestId('test-console-input'), words);
      await fireEvent.press(screen.getByTestId('test-console-send'));
    };
    await write('Can you come Sunday?');
    await waitFor(() => expect(screen.getAllByTestId('reply-feedback')).toHaveLength(1));
    await write('Great, thanks');
    await waitFor(() => expect(screen.getAllByTestId('reply-feedback')).toHaveLength(2));

    await fireEvent.press(screen.getAllByTestId('feedback-bad')[0]!);
    await fireEvent.changeText(
      screen.getByTestId('feedback-better'),
      'We’re closed Sundays. Does Monday at 10 work?',
    );
    await fireEvent.changeText(screen.getByTestId('feedback-note'), 'We don’t work Sundays');
    const given: TeammateFeedbackOut = {
      id: '99999999-9999-4999-8999-999999999999',
      runId: RUN,
      messageId: null,
      isTest: true,
      rating: 'bad',
      betterReply: 'We’re closed Sundays. Does Monday at 10 work?',
      note: 'We don’t work Sundays',
      learn: 'nothing',
      learnWhy: 'It already has a rule for this.',
      question: null,
      choices: [],
      answer: null,
      lesson: null,
      mine: true,
      by: null,
      createdAt: AT,
      updatedAt: AT,
    };
    jest.mocked(change).mockImplementationOnce(async () => {
      mockFeedback = [given];
      return { id: 'cmd', queued: false, output: { feedback: given } } as never;
    });
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(change).toHaveBeenCalledWith('ai_teammate.give_feedback', {
      workspaceId: WS,
      runId: RUN,
      rating: 'bad',
      betterReply: 'We’re closed Sundays. Does Monday at 10 work?',
      note: 'We don’t work Sundays',
      asked: 'Can you come Sunday?',
    });
    await fireEvent.press(await screen.findByTestId('feedback-done'));

    // Retry with the fix: the first message again, with nothing before it, and the turn after it gone.
    await fireEvent.press(screen.getByTestId('feedback-retry'));
    await waitFor(() => expect(mockBodies).toHaveLength(3));
    expect(mockBodies[2]).toMatchObject({
      messages: [{ from: 'customer', text: 'Can you come Sunday?' }],
      coaching: {
        reply: 'Sure, we can come Sunday at 10.',
        better: 'We’re closed Sundays. Does Monday at 10 work?',
        why: 'We don’t work Sundays',
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('test-console-reply')).toHaveTextContent(
        'We’re closed Sundays. Does Monday at 10 work?',
      ),
    );
    expect(mockBodies[0]!.coaching ?? null).toBeNull();
    await rerender(<Harness pane="log" />);
    expect(screen.getByText('Tried again with your feedback')).toBeTruthy();
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

  it('calls out only to someone in Contacts, and says why it calls', async () => {
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
      'Outgoing call · follow up a quote · Now · Warm voice',
    );
  });

  it('tries another voice: Hear it says the greeting in it, and Use this voice saves it', async () => {
    const TEAMMATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const config = {
      version: 3,
      identity: { name: 'Ava', disclosure: 'first_message' },
      phone: { enabled: true, voice: 'warm', greeting: '' },
    };
    const posted: { path: string; body: unknown }[] = [];
    jest.mocked(api.POST as unknown as jest.Mock).mockImplementation(async (path: string, init) => {
      posted.push({ path, body: (init as { body: unknown }).body });
      if (path === '/v1/queries/ai_teammate.get')
        return {
          data: { teammate: { id: TEAMMATE, revision: 4, config } },
          response: { ok: true },
        };
      if (path === '/v1/commands/ai_teammate.save_config')
        return { data: { teammateId: TEAMMATE, revision: 5 }, response: { ok: true } };
      return {
        data: { feedback: [], messageRuns: [], canSaveRules: true },
        response: { ok: true },
      };
    });
    mockSayClip.mockResolvedValue({ uri: 'file:///cache/eyre.mp3', voice: 'rime_eyre' });
    answer(() => [done('Thanks for calling. This is Ava, the AI assistant. How can I help?')]);
    await render(<Harness />);
    await choose('test-channel-phone');
    await waitFor(() => expect(screen.getByTestId('test-call-voice-warm')).toBeChecked());
    await fireEvent.press(screen.getByTestId('test-call-voice-rime_eyre'));
    expect(screen.getByTestId('test-call-voice-trying')).toHaveTextContent(
      'Trying Eyre. Your settings still say another voice.',
    );
    expect(screen.getByTestId('test-console-how')).toHaveTextContent(
      'Incoming call · Now · Eyre voice',
    );

    await fireEvent.press(screen.getByTestId('test-call-voice-hear'));
    await waitFor(() => expect(audio.__played).toContain('file:///cache/eyre.mp3'));
    audio.__played.length = 0;
    expect(mockSayClip.mock.calls[0]![0]).toEqual({
      workspaceId: WS,
      text: 'Thanks for calling. This is Ava, the AI assistant. How can I help?',
      voice: 'rime_eyre',
      language: null,
    });

    await fireEvent.press(screen.getByTestId('test-call-voice-use'));
    await waitFor(() => expect(screen.queryByTestId('test-call-voice-trying')).toBeNull());
    expect(posted.find((p) => p.path === '/v1/commands/ai_teammate.save_config')?.body).toEqual({
      workspaceId: WS,
      teammateId: TEAMMATE,
      baseRevision: 4,
      config: { ...config, phone: { ...config.phone, voice: 'rime_eyre' } },
    });
    expect(screen.getByTestId('test-call-voice-rime_eyre')).toBeChecked();
  });

  it('keeps a Rime voice from being picked until Rime is set up', async () => {
    mockReadiness.mockResolvedValue({ deepgram: true, rime: false });
    await render(<Harness />);
    await choose('test-channel-phone');
    await waitFor(() => expect(screen.getByTestId('test-call-voice-rime_cove')).toBeDisabled());
    expect(screen.getByTestId('test-call-voice-calm')).not.toBeDisabled();
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
