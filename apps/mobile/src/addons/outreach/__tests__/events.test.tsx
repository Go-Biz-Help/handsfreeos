import type { TodayEvent } from '@hfos/core/addons/outreach/events-near';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { EventsPart } from '../events';

/**
 * Events near you on the phone's Today (docs/outreach.md, decision 188; the owner's pick 7a), as the web's: the events
 * read near the person this week, coming up, the soonest first, each with when, where and who hosts it, Open and Not
 * going. Nothing is pressed on the event.
 */

const mixer: TodayEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  url: 'https://www.facebook.com/events/1000001/',
  name: 'Boise Business Mixer',
  when: 'Thursday, December 4 at 7:30 AM',
  startsAt: '2026-12-04T14:30:00.000Z',
  place: 'Boise Centre',
  hosts: ['Morgan Hale', 'Boise Chamber'],
  people: 3,
};
const coffee: TodayEvent = {
  id: '22222222-2222-4222-8222-222222222222',
  url: 'https://www.facebook.com/events/1000002/',
  name: 'Small Business Coffee',
  when: null,
  startsAt: null,
  place: null,
  hosts: [],
  people: 0,
};

describe('events near you on the phone', () => {
  it('lists each event with when, where and who hosts it, and opens its page', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<EventsPart events={[mixer, coffee]} onSkip={jest.fn()} />);
    expect(screen.getByText('Events near you · 2')).toBeTruthy();
    const card = within(screen.getByTestId(`today-event-${mixer.id}`));
    expect(card.getByText('Thursday, December 4 at 7:30 AM')).toBeTruthy();
    expect(card.getByText('Boise Centre')).toBeTruthy();
    expect(card.getByText('Hosted by Morgan Hale, Boise Chamber')).toBeTruthy();
    expect(card.getByText('3 people there to check')).toBeTruthy();
    // An event whose page said little shows its name alone.
    const plain = within(screen.getByTestId(`today-event-${coffee.id}`));
    expect(plain.queryByText(/Hosted by/)).toBeNull();
    expect(plain.queryByText(/to check/)).toBeNull();
    fireEvent.press(card.getByTestId('today-event-open'));
    expect(open).toHaveBeenCalledWith(mixer.url);
    open.mockRestore();
  });

  it('takes one off with Not going', async () => {
    const onSkip = jest.fn();
    await render(<EventsPart events={[mixer]} onSkip={onSkip} />);
    fireEvent.press(screen.getByTestId('today-event-skip'));
    expect(onSkip).toHaveBeenCalledWith(mixer.id);
  });

  it('shows nothing with no events near them', async () => {
    await render(<EventsPart events={[]} onSkip={jest.fn()} />);
    expect(screen.queryByTestId('today-events')).toBeNull();
  });
});
