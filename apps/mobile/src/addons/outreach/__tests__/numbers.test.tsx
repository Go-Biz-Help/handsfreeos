import type { TrackingOutput } from '@hfos/core/addons/outreach/tracking';
import { render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { NumbersPart } from '../numbers';

/**
 * The three numbers on the phone's Results (docs/outreach.md, decision 70): first messages sent, said yes and calls
 * booked against the person's targets, the two rates against the usual ones, the week's review, and the numbers by
 * playbook and by the offer's version; everyone's counts for owners and admins, with no targets and no review.
 */

const PLAYBOOK = '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e';
const TRACKING: TrackingOutput = {
  from: '2026-10-08T05:00:00.000Z',
  timezone: 'America/Chicago',
  period: 'week',
  everyone: false,
  numbers: { messages: 62, positive: 4, booked: 1 },
  rates: { yes: 4 / 62, books: 1 / 4 },
  target: { goal: 8, messages: 75, positive: 5.5, booked: 1.8 },
  byPlaybook: [
    { playbookId: PLAYBOOK, name: 'Roofers', messages: 40, positive: 3, booked: 1 },
    { playbookId: null, name: null, messages: 22, positive: 1, booked: 0 },
  ],
  byVersion: [{ version: 2, live: true, messages: 50, positive: 3, booked: 1 }],
  review: {
    week: '2026-10-05',
    fix: 'volume',
    numbers: { messages: 62, positive: 4, booked: 1 },
    target: 75,
    headline: 'Send more messages first',
    why: 'You sent 62 first messages last week. Your goal takes about 75.',
    steps: ['Start your day on each working day.', 'Add a group or two.'],
    by: 'ai',
    at: '2026-10-12T13:00:00.000Z',
  },
};

describe('the three numbers on the phone', () => {
  it('shows each against the target, the rates against the usual ones, and the week’s review', async () => {
    await render(<NumbersPart tracking={TRACKING} />);
    expect(screen.getByText('Your numbers')).toBeTruthy();
    expect(screen.getByText('Targets from your goal: 8 calls a month')).toBeTruthy();
    expect(screen.getByTestId('results-target-messages')).toHaveTextContent('Target 75');
    expect(screen.getByTestId('results-target-positive')).toHaveTextContent('Target 5.5');
    expect(screen.getByText('Said yes: 6.5%')).toBeTruthy();
    expect(screen.getByText('4 of 62 messages · Most get 4 to 8%')).toBeTruthy();
    expect(screen.getByText('Like most')).toBeTruthy();
    expect(screen.getByText('Booked a call: 25%')).toBeTruthy();
    expect(screen.getByText('1 of 4 yeses · Most book 1 in 3')).toBeTruthy();
    expect(screen.getByText('Below most')).toBeTruthy();
    expect(screen.getByTestId('results-review-headline')).toHaveTextContent(
      'Send more messages first',
    );
    expect(screen.getByText('Your week’s review · Week of Oct 5')).toBeTruthy();
    expect(screen.getByText('Written by the AI from your numbers')).toBeTruthy();
    expect(screen.getByText('Roofers')).toBeTruthy();
    expect(screen.getByText('No playbook')).toBeTruthy();
    expect(screen.getByText('Version 2, live')).toBeTruthy();
    expect(screen.getByText('50 sent · 3 yes · 1 booked')).toBeTruthy();
  });

  it('shows the team’s counts with no targets and no review, and says when there’s no goal', async () => {
    const { rerender } = await render(
      <NumbersPart tracking={{ ...TRACKING, everyone: true, target: null, review: null }} />,
    );
    expect(screen.getByText('The team’s numbers')).toBeTruthy();
    expect(screen.queryByTestId('results-target-messages')).toBeNull();
    expect(screen.queryByTestId('results-review')).toBeNull();
    expect(screen.queryByTestId('results-review-none')).toBeNull();
    await rerender(<NumbersPart tracking={{ ...TRACKING, target: null, review: null }} />);
    expect(
      screen.getByText('Set your goal under Get ready → Your numbers to see your targets.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Your first review comes on Monday morning, from the week before.'),
    ).toBeTruthy();
  });
});
