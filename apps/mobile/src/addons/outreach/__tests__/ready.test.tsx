import { PROFILE_ITEMS, type ReadinessOutput } from '@hfos/core/addons/outreach/readiness';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { GetReadyCard } from '../ready';

/**
 * Get ready on the phone (decision 63): what's left, each item's state, the person's own two done right here, the
 * profile ticked an item at a time and the goal with its math, and nothing once they're ready.
 */

jest.mock('@/changes', () => ({
  change: jest.fn(),
  ChangeError: class extends Error {},
}));

const notReady: ReadinessOutput = {
  ready: false,
  next: 'profile',
  changed: [],
  items: [
    { item: 'offer', state: 'done', whose: 'business', left: null },
    { item: 'playbook', state: 'done', whose: 'business', left: null },
    {
      item: 'profile',
      state: 'todo',
      whose: 'person',
      left: '6 things left to check on your Facebook profile.',
    },
    {
      item: 'numbers',
      state: 'todo',
      whose: 'person',
      left: 'Set a goal for calls booked a month, and see what it takes each day.',
    },
  ],
  offer: { version: 1, line: 'We help roofers get booked inspections.' },
  profile: {},
  numbers: { goal: null, at: null, days: [1, 2, 3, 4, 5], canSend: 15 },
};

describe('Get ready on the phone', () => {
  it('says what’s left, and ticks a profile item', async () => {
    const onTick = jest.fn(async () => undefined);
    await render(<GetReadyCard readiness={notReady} onTick={onTick} onNumbers={jest.fn()} />);
    expect(
      screen.getByText('2 things to do before the extension reaches anyone for you.'),
    ).toBeTruthy();
    expect(screen.getByText('6 things left to check on your Facebook profile.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    const list = screen.getByTestId('ready-profile-list');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(PROFILE_ITEMS.length);
    await fireEvent.press(screen.getByTestId('ready-profile-bio'));
    await waitFor(() => expect(onTick).toHaveBeenCalledWith('bio', true));
  });

  it('works the goal out as it changes, and saves it with the days', async () => {
    const onNumbers = jest.fn(async () => true);
    await render(<GetReadyCard readiness={notReady} onTick={jest.fn()} onNumbers={onNumbers} />);
    await fireEvent.press(screen.getByTestId('ready-open-numbers'));
    expect(screen.getByText('8 calls a month ÷ 22 working days = 0.4 calls a day')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-goal-more'));
    await fireEvent.press(screen.getByTestId('ready-day-6'));
    expect(screen.getByText('9 calls a month ÷ 26 working days = 0.3 calls a day')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-numbers-save'));
    await waitFor(() => expect(onNumbers).toHaveBeenCalledWith(9, [1, 2, 3, 4, 5, 6]));
  });

  it('shows nothing once they’re ready', async () => {
    await render(
      <GetReadyCard
        readiness={{ ...notReady, ready: true, next: null }}
        onTick={jest.fn()}
        onNumbers={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('get-ready')).toBeNull();
  });
});
