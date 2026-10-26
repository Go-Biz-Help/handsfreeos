import type { LiveOutput } from '@hfos/core/addons/outreach/live';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { act, renderHook } from '@testing-library/react-native';

import { toast } from '@/components/ui/toast';

import { openOutreach } from '../kit';
import { useLiveProps } from '../live';
import { id, TZ, WS } from './mocks';

/**
 * Start my day pressed on the phone (the owner, 26 Oct 2026: "if there is something else preventing the day from
 * starting it should tell the user what it is"). Start is a change that waits on the phone, so HandsFreeOS answers
 * after the press: "Your day has started" shows only once it's taken, and a refusal stays beside Start in HandsFreeOS's
 * words, with where it's fixed.
 */

type Row = {
  id: string;
  state: string;
  reason?: string | null;
  rule?: string | null;
  answer?: string | null;
};
let mockRow: Row | null = null;
// Each press is a change of its own.
let mockPresses = 0;
jest.mock('@/changes/hooks', () => ({ useChange: () => mockRow }));
jest.mock('@/changes', () => ({ ChangeError: class extends Error {} }));
jest.mock('@/components/ui/toast', () => ({ toast: { show: jest.fn(), error: jest.fn() } }));
jest.mock('../actions', () => ({
  startDay: jest.fn(async () => ({ id: `change-${++mockPresses}`, queued: true })),
  stopDay: jest.fn(async () => ({ id: `change-${++mockPresses}`, queued: true })),
}));
jest.mock('../asks', () => ({
  ...jest.requireActual<object>('../asks'),
  useAsks: () => ({ data: null, reload: jest.fn() }),
  useAskActions: () => ({}),
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));

const NOW = Date.parse('2026-10-10T15:00:00.000Z');
const LIVE: LiveOutput = {
  timezone: TZ,
  now: new Date(NOW).toISOString(),
  sending: 'steps',
  canSend: true,
  day: { date: '2026-10-10', state: 'none', why: null, via: null, at: null },
  computer: {
    id: id(1),
    name: 'Chrome on Mac',
    lastSeenAt: new Date(NOW - 30_000).toISOString(),
    activeAt: null,
    working: true,
    state: 'working',
    version: '0.16.0',
  },
  computers: [],
  status: null,
  limits: {
    friend_request: { done: 0, most: 20 },
    first_message: { done: 0, most: 20 },
    follow_up: { done: 0, most: 20 },
    comment: { done: 0, most: 20 },
    like: { done: 0, most: 40 },
  },
  waiting: 0,
  warning: null,
  steps: [],
};
const mockAnswer = { data: LIVE, at: NOW - 60_000, error: null, reload: jest.fn() };
const mockWs = WS;
jest.mock('../kit', () => ({
  ...jest.requireActual<object>('../kit'),
  useOutreachContext: () => ({
    workspaceId: mockWs,
    online: true,
    manages: false,
  }),
  useOutreachAnswer: () => mockAnswer,
  openSettingsPart: jest.fn(),
  openOutreach: jest.fn(),
}));

const NUMBERS = 'Your numbers aren’t set yet. Finish it under Get ready on the Today tab.';
const refusedRow: Row = {
  id: 'change-1',
  state: 'refused',
  reason: NUMBERS,
  rule: 'outreach_not_ready',
  answer: JSON.stringify({
    error: {
      code: 'rule_violation',
      message: NUMBERS,
      rule: 'outreach_not_ready',
      details: { item: 'numbers', platform: 'facebook' },
      disposition: 'final',
    },
  }),
};

beforeEach(() => {
  mockRow = null;
  mockPresses = 0;
  jest.mocked(toast.show).mockClear();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('Start my day pressed on the phone', () => {
  it('keeps a refusal beside Start, with where it’s fixed, and never says the day started', async () => {
    const hook = await renderHook(() => useLiveProps(true, 'facebook'));
    await act(async () => hook.result.current.onStart());
    // Online, a start is said once HandsFreeOS takes it: not yet.
    expect(toast.show).not.toHaveBeenCalled();
    mockRow = { id: 'change-1', state: 'sending' };
    await hook.rerender({});
    expect(hook.result.current.pressed).toBe('started');
    mockRow = refusedRow;
    await hook.rerender({});
    expect(hook.result.current.pressed).toBeNull();
    expect(hook.result.current.refused?.words).toBe(NUMBERS);
    // On Details, Get ready's items are fixed under Get ready on Today.
    hook.result.current.refused!.fix!();
    expect(openOutreach).toHaveBeenCalledWith(WS, 'today', 'net=facebook');
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('says the day started once HandsFreeOS has taken it, and lets an earlier refusal go', async () => {
    const hook = await renderHook(() => useLiveProps(false, 'facebook'));
    await act(async () => hook.result.current.onStart());
    mockRow = refusedRow;
    await hook.rerender({});
    expect(hook.result.current.refused?.words).toBe(NUMBERS);
    // On Today's strip, Get ready sits under it: nothing more to press for its items.
    expect(hook.result.current.refused?.fix).toBeNull();
    // Pressed again: the old refusal goes, and an earlier change's answer is never read as this one's.
    await act(async () => hook.result.current.onStart());
    expect(hook.result.current.refused).toBeNull();
    expect(hook.result.current.pressed).toBe('started');
    mockRow = { id: 'change-2', state: 'sent' };
    await hook.rerender({});
    expect(toast.show).toHaveBeenCalledWith(W.started(true));
    expect(hook.result.current.refused).toBeNull();
  });
});
