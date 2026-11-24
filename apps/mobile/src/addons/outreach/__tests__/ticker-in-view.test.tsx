import { COUNTS_ASK_SECONDS, TICKER_ASK_SECONDS } from '@hfos/core/addons/outreach/tallies';
import { act, render } from '@testing-library/react-native';
import * as React from 'react';
import { AppState } from 'react-native';

import { api } from '@/lib/api';
import { InViewProvider } from '@/lib/in-view';

import { OutreachCounters } from '../counters';
import { OutreachTicker } from '../ticker';

/**
 * What Social Outreach asks again and again on the phone, only while it's what the person is looking at (decision
 * 140, as the speed audit left it, Nov 2026): the ticker every 5 seconds and the counters every 15, and from under
 * another screen or another tab neither, nor telling the person's computer that a ticker is being watched. Its screens
 * stay alive there, and went on asking about 34 times a minute.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('../kit', () => ({
  ...jest.requireActual<object>('../kit'),
  useOutreachContext: () => ({
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    timeZone: 'America/Chicago',
    manages: false,
    makesPartners: false,
    writesContacts: true,
    online: true,
  }),
}));

const post = api.POST as unknown as jest.Mock;
/** How many times a path has been asked. */
const asked = (path: string) => post.mock.calls.filter(([p]) => p === path).length;
const TICKER = '/v1/queries/outreach.ticker';
const WATCH = '/v1/commands/outreach.live.watch';
const COUNTS = '/v1/queries/outreach.counts';

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  // Every answer is a refusal: this looks only at what's asked for, never at what comes back.
  post
    .mockReset()
    .mockImplementation(async () => ({ error: { message: 'Not now.' }, response: {} }));
});
afterEach(() => jest.useRealTimers());

/** A second at a time, so an answer lands before the next round comes due, as it does on a phone. */
async function seconds(n: number) {
  for (let i = 0; i < Math.max(n, 1); i += 1) {
    await act(async () => jest.advanceTimersByTime(n === 0 ? 0 : 1000));
  }
}

function Shown({ inView }: { inView: boolean }) {
  return (
    <InViewProvider value={inView}>
      <OutreachTicker />
      <OutreachCounters working={['facebook']} />
    </InViewProvider>
  );
}

describe('Social Outreach asking again on the phone', () => {
  it('asks for the ticker every 5 seconds and the counters every 15 while it’s in view', async () => {
    expect(TICKER_ASK_SECONDS).toBe(5);
    expect(COUNTS_ASK_SECONDS).toBe(15);
    await render(<Shown inView />);
    await seconds(0);
    expect([asked(TICKER), asked(COUNTS), asked(WATCH)]).toEqual([1, 1, 1]);
    await seconds(31);
    // Half a minute on: six more of the ticker's, two more of the counters', and no second word to the computer yet.
    expect([asked(TICKER), asked(COUNTS), asked(WATCH)]).toEqual([7, 3, 1]);
  });

  it('asks nothing from under another screen, and picks up at once when it’s back', async () => {
    const { rerender } = await render(<Shown inView />);
    await seconds(0);
    await rerender(<Shown inView={false} />);
    await seconds(180);
    expect([asked(TICKER), asked(COUNTS), asked(WATCH)]).toEqual([1, 1, 1]);
    await rerender(<Shown inView />);
    await seconds(0);
    // Back: the computer is told it's watched again, and both are asked for without waiting a round.
    expect([asked(TICKER), asked(COUNTS), asked(WATCH)]).toEqual([2, 2, 2]);
  });
});
