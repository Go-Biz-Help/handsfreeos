import type { CountsOutput } from '@hfos/core/addons/outreach/tallies';
import { tickerOf } from '@hfos/core/addons/outreach/tallies';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { CountersBody } from '../counters';
import { TickerBody } from '../ticker';
import { id, TZ } from './mocks';

/**
 * The counters on Today and the ticker under every Social Outreach screen on the phone (docs/outreach.md, decision
 * 140), as the web's: everything the extension did on its own, today, this week or this month, on each network and
 * all together, each group opening to its lines, and the team's person by person for owners; and what the person's
 * computer is doing now, with today's steps going past, held still by a tap.
 */

const counts = (over: Partial<CountsOutput> = {}): CountsOutput => ({
  timezone: TZ,
  period: 'today',
  from: '2026-10-31',
  to: '2026-10-31',
  everyone: false,
  counts: [
    { platform: 'facebook', kind: 'friend_request', n: 12 },
    { platform: 'facebook', kind: 'profile', n: 40 },
    { platform: 'linkedin', kind: 'friend_request', n: 5 },
  ],
  people: null,
  since: '2026-10-31',
  ...over,
});

const body = (
  c: CountsOutput | null,
  more: Partial<React.ComponentProps<typeof CountersBody>> = {},
) => (
  <CountersBody
    counts={c}
    working={['facebook', 'linkedin']}
    period="today"
    onPeriod={jest.fn()}
    whose={null}
    onWhose={jest.fn()}
    {...more}
  />
);

describe('the counters on the phone', () => {
  it('adds up every network, narrows to one, and opens a group to its lines', async () => {
    await render(body(counts()));
    expect(within(screen.getByTestId('counters-total')).getByText('57')).toBeTruthy();
    expect(within(screen.getByTestId('counters-group-reached')).getByText('17')).toBeTruthy();
    expect(screen.queryByTestId('counters-rows-reached')).toBeNull();
    await fireEvent.press(screen.getByTestId('counters-group-reached'));
    const rows = screen.getByTestId('counters-rows-reached');
    expect(within(rows).getByText('Friend requests and follows sent')).toBeTruthy();
    expect(within(rows).getByText('Likes')).toBeTruthy();
    // LinkedIn alone, in its own words.
    await fireEvent.press(screen.getByTestId('counters-net-linkedin'));
    expect(within(screen.getByTestId('counters-total')).getByText('5')).toBeTruthy();
    expect(
      within(screen.getByTestId('counters-rows-reached')).getByText('Invitations to connect sent'),
    ).toBeTruthy();
  });

  it('says when nothing’s been counted, and switches the stretch', async () => {
    const onPeriod = jest.fn();
    await render(body(counts({ counts: [] }), { onPeriod }));
    expect(screen.getByTestId('counters-none')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('counters-period-week'));
    expect(onPeriod).toHaveBeenCalledWith('week');
    // One network, with nothing counted on another: no network tabs.
    await render(body(counts({ counts: [] }), { working: ['facebook'] }));
    expect(screen.queryByTestId('counters-net-all')).toBeNull();
  });

  it('shows owners the team’s, person by person', async () => {
    const onWhose = jest.fn();
    await render(
      body(
        counts({
          everyone: true,
          people: [
            {
              userId: id(1),
              name: 'Morgan Owner',
              counts: [{ platform: 'facebook', kind: 'friend_request', n: 12 }],
            },
            { userId: id(2), name: 'Riley Member', counts: [] },
          ],
        }),
        { whose: 'team', onWhose },
      ),
    );
    const people = screen.getAllByTestId('counters-person');
    expect(people).toHaveLength(2);
    expect(within(people[0]!).getByText('Morgan Owner')).toBeTruthy();
    expect(within(people[0]!).getByText('Reached out 12')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('counters-you'));
    expect(onWhose).toHaveBeenCalledWith('me');
  });
});

describe('the ticker on the phone', () => {
  const at = Date.UTC(2026, 9, 31, 19, 14);
  const ticker = (steps: number) =>
    tickerOf(
      {
        timezone: TZ,
        computer: {
          id: id(9),
          name: 'Chrome on Mac',
          lastSeenAt: new Date(at).toISOString(),
          activeAt: null,
          working: true,
          state: 'working',
          version: '0.120.0',
          allowed: null,
        },
        status: {
          state: 'working',
          line: 'Sending a friend request to Dana Cole',
          lineAt: null,
          nextAt: null,
          doing: null,
        },
        steps: Array.from({ length: steps }, (_, i) => ({
          at: new Date(at - i * 60_000).toISOString(),
          kind: 'done' as const,
          line: `Step ${i + 1}`,
        })),
      },
      at,
    );

  it('leads with what the computer is doing now, then today’s steps, held by a tap', async () => {
    await render(<TickerBody ticker={ticker(2)} />);
    expect(screen.getByTestId('ticker-head').props.children).toBe(
      'Now: Sending a friend request to Dana Cole',
    );
    expect(screen.getAllByText('Step 1').length).toBeGreaterThan(0);
    const pause = screen.getByTestId('ticker-pause');
    expect(pause.props.accessibilityLabel).toBe('Pause');
    await fireEvent.press(pause);
    expect(screen.getByTestId('ticker-pause').props.accessibilityLabel).toBe('Play');
  });

  it('says so when nothing’s been done today, with nothing to pause', async () => {
    await render(<TickerBody ticker={ticker(0)} />);
    expect(screen.getByText('Nothing done yet today.')).toBeTruthy();
    expect(screen.queryByTestId('ticker-pause')).toBeNull();
  });
});
