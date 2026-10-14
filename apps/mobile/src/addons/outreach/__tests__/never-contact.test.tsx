import type { FriendsOutput } from '@hfos/core/addons/outreach/friends';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { ChangeError } from '@/changes';
import { toast } from '@/components/ui/toast';

import { NeverContactBody } from '../never-contact';
import { id } from './mocks';

/**
 * The Never contact list on the phone's People tab, as on the web's Friends tab: who's on it and who added them, a
 * switch that takes someone off (with signal only), a refusal said with why, and an empty list said plainly.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
  ChangeError: class extends Error {
    constructor(_kind: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));

const person = (over: Partial<FriendsOutput['people'][number]> = {}) => ({
  profileId: id(80),
  personId: null,
  name: 'Ash Quill',
  url: 'https://www.facebook.com/ash.quill.4',
  state: null,
  since: null,
  keep: false,
  dontPitch: null,
  neverContact: { by: 'Riley Member', at: '2026-10-12T15:00:00.000Z' },
  mutualFriends: null,
  intro: [],
  group: null,
  friendsSince: null,
  lastMessage: null,
  fit: null,
  check: null,
  ...over,
});

const listOf = (people: FriendsOutput['people']): FriendsOutput => ({
  counts: {
    friends: 0,
    fits: 0,
    requests: 0,
    sent: 0,
    keep: 0,
    dontPitch: 0,
    neverContact: people.length,
  },
  cap: 5000,
  download: null,
  people,
  checks: {
    people: 0,
    checked: 0,
    good: 0,
    maybe: 0,
    waiting: 0,
    again: 0,
    today: 0,
    perDay: 40,
  },
  page: 1,
  pages: 1,
  total: people.length,
  more: 0,
});

const body = (
  list: FriendsOutput | null,
  props: Partial<React.ComponentProps<typeof NeverContactBody>> = {},
) => (
  <NeverContactBody
    search=""
    onSearch={jest.fn()}
    list={list}
    error={null}
    onRetry={jest.fn()}
    onMore={jest.fn()}
    online
    onTakeOff={jest.fn(async () => {})}
    {...props}
  />
);

beforeEach(() => {
  jest.mocked(toast.show).mockClear();
  jest.mocked(toast.error).mockClear();
});

describe('The Never contact list on the phone', () => {
  it('lists who’s on it and who added them, and takes someone off', async () => {
    const onTakeOff = jest.fn(async () => {});
    await render(body(listOf([person()]), { onTakeOff }));
    expect(screen.getByText('Ash Quill')).toBeTruthy();
    expect(screen.getByText(/^Added by Riley Member · Oct 12, 2026$/)).toBeTruthy();
    await fireEvent(screen.getByTestId('never-contact-switch'), 'checkedChange', false);
    await waitFor(() => expect(onTakeOff).toHaveBeenCalledWith(id(80)));
    expect(toast.show).toHaveBeenCalledWith('Ash Quill is off the Never contact list.');
  });

  it('says why when taking someone off is refused', async () => {
    const onTakeOff = jest.fn(async () => {
      throw new ChangeError(
        'refused',
        'Riley Member put Ash Quill on the Never contact list, so only they or an owner or admin can take them off.',
      );
    });
    await render(body(listOf([person()]), { onTakeOff }));
    await fireEvent(screen.getByTestId('never-contact-switch'), 'checkedChange', false);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^Riley Member put/)),
    );
    expect(screen.getByTestId('never-contact-switch').props.accessibilityState.checked).toBe(true);
  });

  it('can’t be switched with no signal, and says when nobody’s on it', async () => {
    const { rerender } = await render(body(listOf([person()]), { online: false }));
    expect(screen.getByTestId('never-contact-switch').props.accessibilityState.disabled).toBe(true);
    await rerender(body(listOf([])));
    expect(screen.getByText('Nobody on the Never contact list')).toBeTruthy();
  });
});
