import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { DemoPlayerBar } from '@/components/demo/demo-player';
import { sayingMs } from '@/demo/autoplay';
import { playPress } from '@/demo/pretend';
import { findPhoneScene } from '@/demo/scenes';
import { currentDemo, dropDemo, keepDemo, type PhoneDemo } from '@/demo/state';

/**
 * Play on its own on the phone's demo player: the player goes out of sight, nothing is left on screen to record but
 * the app, the steps play themselves after their voiceovers, Approve on the lock screen still waits for the
 * presenter, and holding the top edge brings the player back.
 */

const VIEWER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';

jest.mock('@/lib/auth', () => ({
  session: {
    getState: () => ({
      status: 'signedIn',
      person: { userId: '11111111-1111-4111-8111-111111111111', name: 'Dale Ramsey' },
      expiresAt: 0,
    }),
  },
}));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn(), replace: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/demo/hooks', () => ({
  useBusinessDemo: () =>
    jest
      .requireActual('@/demo/state')
      .useDemo('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
}));
jest.mock('@/demo/push', () => ({
  clearDemoPushes: jest.fn(async () => undefined),
  notificationsAllowed: jest.fn(async () => true),
  scheduleDemoPush: jest.fn(async () => undefined),
}));
jest.mock('@/inbox/use-inbox', () => ({ useTeammate: () => ({ name: 'Ava' }) }));
jest.mock('@/components/shell/business-context', () => ({
  businessHref: (ws: string, path?: string) => `/app/w/${ws}${path ? `/${path}` : ''}`,
}));

const scene = findPhoneScene('lock-screen-approve')!;

function start(): void {
  const demo: PhoneDemo = {
    viewerId: VIEWER,
    workspaceId: WS,
    scene: scene.id,
    steps: [],
    startedAt: Date.now(),
    business: 'Bayou Plumbing Co.',
    teammate: 'Ava',
    me: 'Dale',
    myName: 'Dale Ramsey',
    timeZone: 'America/Chicago',
    read: [],
    typed: [],
  };
  keepDemo(demo);
}

const played = () => currentDemo()?.steps.length ?? 0;

beforeEach(() => {
  jest.useFakeTimers();
  start();
});

afterEach(() => {
  dropDemo();
  jest.useRealTimers();
});

it('hides the player completely and plays each step after its voiceover, waiting for Approve on the lock screen', async () => {
  await render(<DemoPlayerBar />);
  expect(screen.getByTestId('demo-player')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('demo-player-play-alone'));
  expect(screen.queryByTestId('demo-player')).toBeNull();
  expect(screen.queryByTestId('demo-player-show')).toBeNull();
  expect(screen.getByTestId('demo-player-auto')).toBeTruthy();

  // A moment after starting, the first step plays.
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(played()).toBe(1);

  // Once its voiceover has been said, the next: lock your phone, the notification on its way.
  await act(async () => {
    jest.advanceTimersByTime(sayingMs(scene.steps[0]!.voiceover));
  });
  expect(played()).toBe(2);

  // Approve is the presenter's to press on the lock screen: it waits, however long.
  await act(async () => {
    jest.advanceTimersByTime(120_000);
  });
  expect(played()).toBe(2);
  expect(screen.getByTestId('demo-player-auto')).toBeTruthy();

  // Approved from the lock screen: the scene carries on by itself after that step's voiceover.
  await act(async () => {
    expect(playPress('approve')).toBe(true);
  });
  expect(played()).toBe(3);
  await act(async () => {
    jest.advanceTimersByTime(sayingMs(scene.steps[2]!.voiceover));
  });
  expect(played()).toBe(4);

  // The scene is over: once the last voiceover is said, the player is back.
  await act(async () => {
    jest.advanceTimersByTime(sayingMs(scene.steps[3]!.voiceover));
  });
  expect(screen.getByTestId('demo-player-done')).toBeTruthy();
});

it('holding the top edge brings the player back where the scene is up to', async () => {
  await render(<DemoPlayerBar />);
  await fireEvent.press(screen.getByTestId('demo-player-play-alone'));
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  await fireEvent(screen.getByTestId('demo-player-auto'), 'longPress');
  expect(screen.getByTestId('demo-player')).toBeTruthy();
  expect(screen.getByTestId('demo-player-next-step')).toHaveTextContent(scene.steps[1]!.label);
});
