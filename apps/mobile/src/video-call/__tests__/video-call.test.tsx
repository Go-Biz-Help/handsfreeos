import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { api } from '@/lib/api';
import { workerPost } from '@/lib/worker';
import { afterCall, endOf } from '@/video-call/ends';
import { mediaProblem } from '@/video-call/media';
import { PhoneCall } from '@/video-call/phone-call';
import { askingToJoin, whoIsHere, type VideoCallPerson } from '@/video-call/team-call';

/**
 * A HandsFreeOS video call on the phone (docs/video-calls.md, "On the phone"): what the screen says before, during and
 * after, and Join asking the worker for a ticket. LiveKit's room is native, so a real ticket's room is a stand-in here;
 * the worker's own stand-in tickets (`fake:`) draw the app's test call.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), canGoBack: () => true, replace: jest.fn(), push: jest.fn() },
}));
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn() }));
jest.mock('@/lib/grants', () => ({ useGrants: () => ({ role: 'owner', permissions: [] }) }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));
jest.mock('@/video-call/load-room', () => {
  const { Text: T } = jest.requireActual('react-native');
  const Room = ({
    title,
    choices,
  }: {
    title: string;
    choices: { mic: boolean; camera: boolean };
  }) => (
    <T testID="live-room">
      {title} mic:{String(choices.mic)} camera:{String(choices.camera)}
    </T>
  );
  // Already loaded, as React.lazy takes a thenable that answers at once: nothing waits on it here.
  return { loadRoom: () => ({ then: (done: (m: unknown) => void) => done({ default: Room }) }) };
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CALL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const post = api.POST as unknown as jest.Mock;
const worker = workerPost as unknown as jest.Mock;

const person = (over: Partial<VideoCallPerson>): VideoCallPerson => ({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  kind: 'customer',
  name: 'Ana Garcia',
  state: 'waiting',
  userId: null,
  personId: null,
  connected: false,
  askedAt: null,
  joinedAt: null,
  leftAt: null,
  seconds: 0,
  onStage: false,
  ...over,
});

const got = (over: { state?: string; aiNotes?: boolean; people?: VideoCallPerson[] } = {}) => ({
  call: {
    id: CALL,
    state: over.state ?? 'open',
    appointmentId: null,
    personId: null,
    hostUserId: null,
    aiNotes: over.aiNotes ?? true,
    startedAt: null,
    endedAt: null,
  },
  appointment: {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    title: 'Duct cleaning quote',
    startsAt: '2026-10-28T15:00:00.000Z',
    endsAt: '2026-10-28T15:30:00.000Z',
    status: 'scheduled',
    customers: [{ personId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Ana Garcia' }],
  },
  host: null,
  people: over.people ?? [person({})],
});

beforeEach(() => {
  post.mockReset();
  worker.mockReset();
});

describe('how a call ends', () => {
  it('reads LiveKit’s reason, and says what happened and how to get back in', () => {
    expect(endOf('CLIENT_INITIATED')).toBe('left');
    expect(endOf('PARTICIPANT_REMOVED')).toBe('removed');
    expect(endOf('ROOM_DELETED')).toBe('ended');
    expect(endOf('ROOM_CLOSED')).toBe('ended');
    expect(endOf('DUPLICATE_IDENTITY')).toBe('elsewhere');
    expect(endOf('SIGNAL_CLOSE')).toBe('lost');
    expect(endOf(undefined)).toBe('lost');
    expect(afterCall('left')).toEqual({ title: 'You left the call.', body: null, again: 'Rejoin' });
    expect(afterCall('ended').again).toBe('Start it again');
    expect(afterCall('elsewhere').again).toBe('Join here instead');
  });

  it('sends someone who said no to the camera to Settings, and anything else to try again', () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    expect(mediaProblem(denied, 'camera')).toEqual({
      message: 'HandsFreeOS can’t use your camera. Allow it in Settings, then turn it on again.',
      settings: true,
    });
    expect(mediaProblem(new Error('Could not start audio source'), 'microphone')).toEqual({
      message: 'Your microphone didn’t start. Close any other app using it, then try again.',
      settings: false,
    });
  });
});

describe('who is in the call', () => {
  it('lists who is asking to come in and isn’t in the room yet', () => {
    const guest = person({ id: 'g1', kind: 'guest', name: 'Dana' });
    const inside = person({ id: 'c1', state: 'in', connected: true });
    const comingIn = person({ id: 'a1', kind: 'guest', state: 'admitted' });
    expect(askingToJoin([guest, inside, comingIn], new Set(['c1'])).map((p) => p.id)).toEqual([
      'g1',
      'a1',
    ]);
    expect(askingToJoin([comingIn], new Set(['a1']))).toEqual([]);
  });

  it('says who is waiting or in before you join', () => {
    expect(whoIsHere([person({})])).toBe('Ana Garcia is waiting for you.');
    expect(
      whoIsHere([
        person({ id: '1', name: 'Ana', state: 'in', connected: true }),
        person({ id: '2', name: 'Sam', kind: 'team', state: 'in', connected: true }),
      ]),
    ).toBe('Ana and Sam are in the call.');
    expect(
      whoIsHere(
        ['A', 'B', 'C'].map((name, i) =>
          person({ id: String(i), name, state: 'in', connected: true }),
        ),
      ),
    ).toBe('A and 2 others are in the call.');
    expect(whoIsHere([])).toBe('Nobody is in the call yet.');
  });
});

describe('the call screen', () => {
  const answer = (value: unknown) =>
    post.mockImplementation(async (path: string) =>
      path === '/v1/queries/video_call.get' ? { data: value } : { data: { ok: true } },
    );

  it('shows the call before joining, then joins on the worker’s ticket with what was picked', async () => {
    answer(got());
    worker.mockResolvedValue({
      workspaceId: WS,
      personId: ME,
      name: 'Dale',
      ticket: { url: 'wss://calls.example.com', token: 't' },
    });
    await render(<PhoneCall workspaceId={WS} callId={CALL} />);
    await waitFor(() =>
      expect(screen.getByTestId('call-heading')).toHaveTextContent('Duct cleaning quote'),
    );
    expect(post).toHaveBeenCalledWith('/v1/queries/video_call.get', {
      body: { workspaceId: WS, callId: CALL },
    });
    expect(screen.getByTestId('call-who')).toHaveTextContent('Ana Garcia is waiting for you.');
    expect(screen.getByTestId('call-ai-notice')).toHaveTextContent(
      /^AI takes notes from what’s said in the call\./,
    );

    await fireEvent.press(screen.getByTestId('call-pre-camera'));
    await fireEvent.press(screen.getByTestId('call-join'));
    expect(worker).toHaveBeenCalledWith('/v1/video-calls/join', { callId: CALL });
    await waitFor(() =>
      expect(screen.getByTestId('live-room')).toHaveTextContent(
        'Duct cleaning quote mic:true camera:false',
      ),
    );
  });

  it('says why it didn’t join, and an ended call starts again', async () => {
    answer(got({ state: 'ended', aiNotes: false }));
    worker.mockRejectedValue(new Error('Video calls aren’t on for this business.'));
    await render(<PhoneCall workspaceId={WS} callId={CALL} />);
    await waitFor(() =>
      expect(screen.getByTestId('call-who')).toHaveTextContent(/^Everyone has left\./),
    );
    expect(screen.queryByTestId('call-ai-notice')).toBeNull();
    expect(screen.getByTestId('call-join')).toHaveTextContent('Start it again');
    await fireEvent.press(screen.getByTestId('call-join'));
    expect(screen.getByTestId('call-error')).toHaveTextContent(
      'Video calls aren’t on for this business.',
    );
  });

  it('runs the stand-in’s test call: Let in works, and Leave says so with Rejoin', async () => {
    const guest = person({ id: 'g1', kind: 'guest', name: 'Dana' });
    answer(got({ people: [guest] }));
    worker.mockResolvedValue({
      workspaceId: WS,
      personId: ME,
      name: 'Dale',
      ticket: { url: 'fake:', token: 'stand-in' },
    });
    await render(<PhoneCall workspaceId={WS} callId={CALL} />);
    await waitFor(() => expect(screen.getByTestId('call-join')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('call-join'));
    await waitFor(() => expect(screen.getByTestId('call-stand-in')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Dana is asking to join')).toBeTruthy());
    await fireEvent.press(screen.getByText('Let in'));
    expect(post).toHaveBeenCalledWith('/v1/commands/video_call.admit', {
      body: { workspaceId: WS, callId: CALL, personId: 'g1' },
    });

    await fireEvent.press(screen.getByTestId('call-leave'));
    await waitFor(() =>
      expect(screen.getByTestId('call-after')).toHaveTextContent('You left the call.'),
    );
    expect(screen.getByTestId('call-again')).toHaveTextContent('Rejoin');
  });

  it('says when the call has gone', async () => {
    answer({ call: null, appointment: null, host: null, people: [] });
    await render(<PhoneCall workspaceId={WS} callId={CALL} />);
    await waitFor(() =>
      expect(screen.getByTestId('call-problem')).toHaveTextContent(
        /^This call isn’t here any more\./,
      ),
    );
  });
});
