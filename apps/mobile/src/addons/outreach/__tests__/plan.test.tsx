import { PLAN_STANDS, PLAN_WORDS, type PlanOutput } from '@hfos/core/addons/outreach/plan';
import { render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { PlanBody } from '../plan';
import { TZ } from './mocks';

/**
 * Today's Plan on the phone (decision 195): where the day stands, what the person asked for first, what's coming with
 * about when, and what's done so far, each only when there's something to show.
 */

const NOW = '2026-10-10T15:00:00.000Z';
const plan = (more: Partial<PlanOutput> = {}): PlanOutput => ({
  platform: 'facebook',
  timezone: TZ,
  now: NOW,
  reported: true,
  stand: 'going',
  line: 'Next at 10:05 AM: Send a friend request (Dana Reyes).',
  doing: null,
  until: '2026-10-10T22:00:00.000Z',
  asked: [],
  coming: [
    {
      at: '2026-10-10T15:05:00.000Z',
      about: false,
      now: false,
      kind: 'step',
      title: 'Send a friend request',
      who: 'Dana Reyes',
      detail: null,
    },
    {
      at: '2026-10-10T15:40:00.000Z',
      about: true,
      now: false,
      kind: 'job',
      title: 'Find posts',
      who: null,
      detail: null,
    },
  ],
  more: 12,
  done: [{ title: 'Friend requests', line: 'Confirmed 2 friend requests.' }],
  counts: [{ label: 'friend requests sent', count: 3 }],
  notes: [],
  ...more,
});

describe('Today’s Plan on the phone', () => {
  it('shows where the day stands, what’s coming with about when, and what’s done', async () => {
    await render(<PlanBody plan={plan()} many={false} />);
    expect(screen.getByText(PLAN_WORDS.title)).toBeTruthy();
    expect(screen.getByText(PLAN_STANDS.going)).toBeTruthy();
    expect(screen.getByTestId('plan-line')).toHaveTextContent(
      'Next at 10:05 AM: Send a friend request (Dana Reyes).',
    );
    expect(screen.getAllByTestId('plan-row')).toHaveLength(2);
    expect(screen.getByText('10:05 AM')).toBeTruthy();
    expect(screen.getByText('About 10:40 AM')).toBeTruthy();
    expect(screen.getByTestId('plan-more')).toHaveTextContent('And 12 more before 5:00 PM.');
    expect(screen.getByText('3 friend requests sent')).toBeTruthy();
    expect(screen.getByText('Confirmed 2 friend requests.')).toBeTruthy();
    expect(screen.queryByTestId('plan-asked')).toBeNull();
  });

  it('names the network when the person works more than one, and puts what they asked for first', async () => {
    await render(
      <PlanBody
        plan={plan({
          platform: 'linkedin',
          stand: 'asks',
          asked: [
            {
              askId: '00000000-0000-4000-8000-000000000001',
              title: 'Withdraw old invitations',
              working: true,
            },
          ],
        })}
        many
      />,
    );
    expect(screen.getByText(PLAN_WORDS.titleOn('LinkedIn'))).toBeTruthy();
    expect(screen.getByText(PLAN_WORDS.asked)).toBeTruthy();
    expect(screen.getByText(PLAN_WORDS.askWorking)).toBeTruthy();
    expect(screen.getByText('Withdraw old invitations')).toBeTruthy();
  });

  it('lists nothing coming before the extension has said where its day is up to', async () => {
    await render(
      <PlanBody
        plan={plan({
          reported: false,
          stand: 'waiting',
          line: PLAN_WORDS.update,
          coming: [],
          more: 0,
          done: [],
          counts: [],
        })}
        many={false}
      />,
    );
    expect(screen.getByTestId('plan-line')).toHaveTextContent(PLAN_WORDS.update);
    expect(screen.queryByTestId('plan-coming')).toBeNull();
    expect(screen.queryByTestId('plan-done')).toBeNull();
  });
});
