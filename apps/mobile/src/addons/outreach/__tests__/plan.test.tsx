import { PLAN_STANDS, PLAN_WORDS, type PlanOutput } from '@hfos/core/addons/outreach/plan';
import { PLAN_CHANGE_UI, PLAN_CHANGE_WORDS } from '@hfos/core/addons/outreach/plan-changes';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { PlanBody, type PlanChanger } from '../plan';
import { TZ } from './mocks';

/**
 * Today's Plan on the phone (decision 195): where the day stands, what the person asked for first, what's coming with
 * about when, and what's done so far, each only when there's something to show. And step 3's buttons: a row that can
 * be changed opens a sheet with Do now, Skip today and the times to move it to; what was skipped or moved is listed
 * with Put back.
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
      key: 'work:step:dana',
      can: ['now', 'skip', 'at'],
      changed: null,
    },
    {
      at: '2026-10-10T15:40:00.000Z',
      about: true,
      now: false,
      kind: 'job',
      title: 'Find posts',
      who: null,
      detail: null,
      key: null,
      can: [],
      changed: null,
    },
  ],
  more: 12,
  done: [{ title: 'Friend requests', line: 'Confirmed 2 friend requests.' }],
  counts: [{ label: 'friend requests sent', count: 3 }],
  notes: [],
  changes: [],
  ...more,
});

/** A changer that answers with these words, and remembers what it was asked. */
const changer = (words: string) =>
  jest.fn<ReturnType<PlanChanger>, Parameters<PlanChanger>>(async () => words);

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

  it('only shows the rows with no signal: nothing can be pressed', async () => {
    await render(<PlanBody plan={plan()} many={false} />);
    expect(
      screen.queryByLabelText(PLAN_CHANGE_UI.menu('Send a friend request (Dana Reyes)')),
    ).toBeNull();
    expect(screen.queryByTestId('plan-row-sheet')).toBeNull();
  });

  it('opens a row that can be changed, and skips it for today', async () => {
    const onChange = changer('Skipped for today.');
    await render(<PlanBody plan={plan()} many={false} onChange={onChange} />);
    // Only the row that can be told something is a button.
    expect(screen.getAllByRole('button', { name: /^Change: / })).toHaveLength(1);
    await fireEvent.press(
      screen.getByLabelText(PLAN_CHANGE_UI.menu('Send a friend request (Dana Reyes)')),
    );
    expect(await screen.findByText(PLAN_CHANGE_WORDS.now)).toBeTruthy();
    expect(screen.getByText(PLAN_CHANGE_WORDS.at)).toBeTruthy();
    // No Put back on a row nothing was changed on.
    expect(screen.queryByTestId('plan-row-back')).toBeNull();
    await fireEvent.press(screen.getByTestId('plan-row-skip'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('work:step:dana', 'skip', undefined));
  });

  it('moves a row to a time picked from every half hour left before the plan ends', async () => {
    const onChange = changer('Moved to about 3:30 PM.');
    await render(<PlanBody plan={plan()} many={false} onChange={onChange} />);
    await fireEvent.press(
      screen.getByLabelText(PLAN_CHANGE_UI.menu('Send a friend request (Dana Reyes)')),
    );
    // 10:00 AM now, and the plan ends at 5:00 PM: 10:30 AM is the first time, 4:30 PM the last.
    expect(await screen.findByTestId('plan-row-at-10:30')).toBeTruthy();
    expect(screen.getByTestId('plan-row-at-16:30')).toBeTruthy();
    expect(screen.queryByTestId('plan-row-at-17:00')).toBeNull();
    await fireEvent.press(screen.getByTestId('plan-row-at-15:30'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('work:step:dana', 'at', '15:30'));
  });

  it('offers only what the row can be told, and Put back on one put first', async () => {
    const onChange = changer('Put back on today’s plan.');
    const first = plan();
    await render(
      <PlanBody
        plan={plan({
          coming: [{ ...first.coming[0]!, can: ['skip', 'at'], changed: 'at' }, first.coming[1]!],
        })}
        many={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('plan-row-changed')).toHaveTextContent(PLAN_CHANGE_UI.moved);
    await fireEvent.press(
      screen.getByLabelText(PLAN_CHANGE_UI.menu('Send a friend request (Dana Reyes)')),
    );
    expect(await screen.findByTestId('plan-row-back')).toBeTruthy();
    // HandsFreeOS doesn't set the order there: no Do now.
    expect(screen.queryByTestId('plan-row-now')).toBeNull();
    await fireEvent.press(screen.getByTestId('plan-row-back'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('work:step:dana', 'back', undefined));
  });

  it('lists what was skipped or moved today, each with Put back', async () => {
    const onChange = changer('Put back on today’s plan.');
    const changes: PlanOutput['changes'] = [
      { key: 'work:step:sam', change: 'skip', at: null, title: 'Send a friend request (Sam Lee)' },
      {
        key: 'work:step:kim',
        change: 'at',
        at: '2026-10-10T20:30:00.000Z',
        title: 'Like a post (Kim Park)',
      },
    ];
    await render(<PlanBody plan={plan({ changes })} many={false} onChange={onChange} />);
    expect(screen.getByText(PLAN_CHANGE_UI.changed)).toBeTruthy();
    expect(screen.getByText('Send a friend request (Sam Lee)')).toBeTruthy();
    expect(screen.getByText(PLAN_CHANGE_UI.skipped)).toBeTruthy();
    expect(screen.getByText('Moved to 3:30 PM')).toBeTruthy();
    await fireEvent.press(screen.getAllByTestId('plan-put-back')[1]!);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('work:step:kim', 'back', undefined));
  });

  it('shows a plan from an API that says nothing of changes yet, with nothing to press', async () => {
    const old = plan();
    const { changes: _none, ...rest } = old;
    const coming = old.coming.map(({ key: _k, can: _c, changed: _ch, ...row }) => row);
    const onChange = changer('');
    await render(
      <PlanBody
        plan={{ ...rest, coming } as unknown as PlanOutput}
        many={false}
        onChange={onChange}
      />,
    );
    expect(screen.getAllByTestId('plan-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Change: / })).toBeNull();
    expect(screen.queryByTestId('plan-changed')).toBeNull();
  });
});
