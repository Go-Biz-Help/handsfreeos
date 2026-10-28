import { VIDEO_CALL_WORDS as W } from '@hfos/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Pressable, Text } from 'react-native';

import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { workerPost } from '@/lib/worker';
import { useCanStartVideoCall, useStartVideoCall } from '@/video-call/start-call';

/**
 * Calls any time on the phone (docs/video-calls.md, part 5): **Video call** sends the customer their own link and
 * opens the call here; with a number and an email it asks which first, and in quiet hours only a person's yes sends
 * the text. The button shows only where the business has calls and the person can change appointments and use the
 * inbox.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn() }));
jest.mock('@/changes', () => ({
  NEEDS_SIGNAL: 'This needs signal. Try again once you’re online.',
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
let mockGrants: { role: string; permissions: string[] | null } = {
  role: 'owner',
  permissions: null,
};
jest.mock('@/lib/grants', () => ({ useGrants: () => mockGrants }));
jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    rule: string | null;
    constructor(
      message: string,
      _status: number,
      _code: string,
      _disposition: null,
      rule: string | null,
    ) {
      super(message);
      this.rule = rule;
    }
  }
  return {
    ApiError,
    api: { POST: jest.fn() },
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
    unwrap: (result: { data?: unknown; error?: unknown }) => {
      if (result.error) throw new Error(String(result.error));
      return result.data;
    },
  };
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CALL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DANA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const worker = workerPost as unknown as jest.Mock;
const post = api.POST as unknown as jest.Mock;
const shown = jest.spyOn(toast, 'show');
const failed = jest.spyOn(toast, 'error');
const dismissed = jest.spyOn(toast, 'dismiss');

const started = (channel: 'sms' | 'email') => ({
  callId: CALL,
  personId: DANA,
  conversationId: null,
  channel,
  name: 'Dana Ortiz',
});

function Starter({ after }: { after?: string }) {
  const video = useStartVideoCall(WS);
  return (
    <>
      <Pressable
        testID="start-by-text"
        onPress={() => void video.start({ personId: DANA, channel: 'sms' }, { after })}
      />
      <Pressable
        testID="start-choose"
        onPress={() => video.choose(DANA, '(512) 555-0142', 'dana@example.test')}
      />
      <Text testID="busy">{String(video.busy)}</Text>
      {video.sheet}
    </>
  );
}

/** The sheet's iOS `onDismiss`, which says it has gone: a pick opens nothing while a modal is still going. */
function modalGone(): () => void {
  type Node = { props: Record<string, unknown>; parent: Node | null };
  let node = screen.getByTestId('video-call-ask') as unknown as Node | null;
  while (node && typeof node.props.onDismiss !== 'function') node = node.parent;
  return node!.props.onDismiss as () => void;
}

/** The sheet sliding away, after which iOS says it has gone. */
const slideAway = () => act(async () => jest.advanceTimersByTime(1_000));

beforeEach(() => {
  jest.useFakeTimers();
  mockOnline = true;
  mockGrants = { role: 'owner', permissions: null };
  worker.mockReset();
  post.mockReset();
  shown.mockClear();
  failed.mockClear();
  dismissed.mockClear();
  (router.push as jest.Mock).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('starting a call with a customer', () => {
  it('sends their link, says how, and opens the call', async () => {
    worker.mockResolvedValue(started('sms'));
    await render(<Starter after={W.switchHint} />);
    await fireEvent.press(screen.getByTestId('start-by-text'));
    expect(worker).toHaveBeenCalledWith('/v1/video-calls/start', {
      workspaceId: WS,
      personId: DANA,
      channel: 'sms',
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/app/w/${WS}/call/${CALL}`));
    expect(shown).toHaveBeenNthCalledWith(1, W.starting);
    expect(shown).toHaveBeenLastCalledWith(`${W.started('Dana Ortiz', 'sms')} ${W.switchHint}`);
    expect(screen.getByTestId('busy')).toHaveTextContent('false');
  });

  it('asks nothing of the worker without signal', async () => {
    mockOnline = false;
    await render(<Starter />);
    await fireEvent.press(screen.getByTestId('start-by-text'));
    expect(worker).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith('This needs signal. Try again once you’re online.');
  });

  it('says what the worker refused', async () => {
    worker.mockRejectedValue(
      new ApiError(
        'Dana Ortiz has no mobile number or email. Add one on their page first.',
        422,
        'invalid',
        null,
        'video_call_no_way',
      ),
    );
    await render(<Starter />);
    await fireEvent.press(screen.getByTestId('start-by-text'));
    await waitFor(() =>
      expect(failed).toHaveBeenCalledWith(
        'Dana Ortiz has no mobile number or email. Add one on their page first.',
      ),
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('video-call-send-anyway')).toBeNull();
  });

  it('asks text or email when there are both, then starts once the sheet has gone', async () => {
    worker.mockResolvedValue(started('email'));
    await render(<Starter />);
    await fireEvent.press(screen.getByTestId('start-choose'));
    expect(screen.getByText(W.sendBy.sms('(512) 555-0142'))).toBeTruthy();
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('video-call-by-email'));
    await slideAway();
    expect(worker).not.toHaveBeenCalled();
    await act(async () => gone());
    expect(worker).toHaveBeenCalledWith('/v1/video-calls/start', {
      workspaceId: WS,
      personId: DANA,
      channel: 'email',
    });
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(shown).toHaveBeenLastCalledWith(W.started('Dana Ortiz', 'email'));
  });

  it('in quiet hours, sends the text only on a yes', async () => {
    const quiet = 'It’s 10:40 PM for Dana Ortiz. Texts wait until 8 AM unless you send it anyway.';
    worker
      .mockRejectedValueOnce(new ApiError(quiet, 409, 'conflict', null, 'quiet_hours'))
      .mockResolvedValueOnce(started('sms'));
    await render(<Starter after={W.switchHint} />);
    await fireEvent.press(screen.getByTestId('start-by-text'));
    await waitFor(() => expect(screen.getByText(quiet)).toBeTruthy());
    expect(dismissed).toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('video-call-send-anyway'));
    await slideAway();
    expect(worker).toHaveBeenCalledTimes(1);
    await act(async () => gone());
    expect(worker).toHaveBeenLastCalledWith('/v1/video-calls/start', {
      workspaceId: WS,
      personId: DANA,
      channel: 'sms',
      acknowledgeQuietHours: true,
    });
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(shown).toHaveBeenLastCalledWith(`${W.started('Dana Ortiz', 'sms')} ${W.switchHint}`);
  });

  it('in quiet hours, Not now sends nothing', async () => {
    worker.mockRejectedValueOnce(
      new ApiError('Texts wait until 8 AM.', 409, 'conflict', null, 'quiet_hours'),
    );
    await render(<Starter />);
    await fireEvent.press(screen.getByTestId('start-by-text'));
    await waitFor(() => expect(screen.getByTestId('video-call-not-now')).toBeTruthy());
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('video-call-not-now'));
    await slideAway();
    await act(async () => gone());
    expect(worker).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('who sees Video call', () => {
  function Can({ ws }: { ws: string }) {
    return <Text testID="can">{String(useCanStartVideoCall(ws))}</Text>;
  }
  const on = (videoCalls: boolean) => ({ data: { workspace: { videoCalls } } });

  it('a business with calls, and someone who can change appointments and use the inbox', async () => {
    post.mockResolvedValue(on(true));
    await render(<Can ws="dddddddd-dddd-4ddd-8ddd-dddddddddd01" />);
    await waitFor(() => expect(screen.getByTestId('can')).toHaveTextContent('true'));
    expect(post).toHaveBeenCalledWith('/v1/queries/workspace.get', {
      body: { workspaceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01' },
    });
  });

  it('nobody in a business without calls, and the answer is kept while the app is open', async () => {
    post.mockResolvedValue(on(false));
    const ws = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02';
    const first = await render(<Can ws={ws} />);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('can')).toHaveTextContent('false');
    await first.unmount();
    await render(<Can ws={ws} />);
    expect(screen.getByTestId('can')).toHaveTextContent('false');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('not someone who can’t use the inbox', async () => {
    post.mockResolvedValue(on(true));
    mockGrants = { role: 'member', permissions: ['appointments.write'] };
    await render(<Can ws="dddddddd-dddd-4ddd-8ddd-dddddddddd03" />);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.getByTestId('can')).toHaveTextContent('false');
  });

  it('asks only once there’s signal', async () => {
    mockOnline = false;
    await render(<Can ws="dddddddd-dddd-4ddd-8ddd-dddddddddd04" />);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('can')).toHaveTextContent('false');
  });
});
