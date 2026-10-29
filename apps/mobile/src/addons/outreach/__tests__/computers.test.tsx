import type { ComputerShown } from '@hfos/core/addons/outreach/live';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { computerNameProblem, ComputersPart, type ComputerActions } from '../computers';
import { id, TZ } from './mocks';

/**
 * The person's computers on the phone, under Settings → Your computer (the Live screen), as the web's Settings has
 * them: each with how it stands and when it was last seen, to rename, checked as the rename checks it, or, for one
 * standing by, to remove; with more than one standing by, all of them at once after asking. The one that works stays.
 */

jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));

const NOW = Date.parse('2026-10-20T15:00:00.000Z');

const computer = (n: number, over: Partial<ComputerShown> = {}): ComputerShown => ({
  id: id(n),
  name: `Office laptop ${n}`,
  lastSeenAt: '2026-10-20T14:58:00.000Z',
  activeAt: null,
  working: false,
  state: 'idle',
  version: '1.4.0',
  allowed: null,
  ...over,
});

const actions = () => ({
  rename: jest.fn(async (_id: string, _name: string): Promise<string | null> => null),
  remove: jest.fn(async (_ids: readonly string[], _done: string) => true),
});

const part = (computers: ComputerShown[], a: ComputerActions, online = true) => (
  <ComputersPart computers={computers} timeZone={TZ} now={NOW} online={online} actions={a} />
);

describe('Your computers on the phone', () => {
  it('lists each with how it stands, and none of it with no computers', async () => {
    await render(part([], actions()));
    expect(screen.queryByTestId('live-computers')).toBeNull();
    await render(part([computer(1, { working: true, state: 'working' }), computer(2)], actions()));
    const rows = screen.getAllByTestId('live-computer-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Office laptop 1')).toBeTruthy();
    expect(within(rows[0]!).getByText(/^Working for you · seen /)).toBeTruthy();
    expect(within(rows[1]!).getByText(/^Standing by · seen /)).toBeTruthy();
    // The one that works can't be removed: HandsFreeOS refuses it too.
    expect(within(rows[0]!).queryByTestId('live-computer-remove')).toBeNull();
    expect(within(rows[1]!).getByTestId('live-computer-remove')).toBeTruthy();
    // Only one standing by: no Remove them all.
    expect(screen.queryByTestId('live-computers-clear')).toBeNull();
  });

  it('checks a new name as the rename does, and says the rename’s own refusal', async () => {
    expect(computerNameProblem('   ')).toBe('Give the computer a name.');
    expect(computerNameProblem('x'.repeat(200))).toMatch(/^Keep the name to \d+ characters\.$/);
    expect(computerNameProblem('Kitchen desktop')).toBeNull();
    const a = actions();
    a.rename.mockResolvedValueOnce('That computer isn’t yours anymore. Open Settings again.');
    await render(part([computer(1, { working: true })], a));
    await fireEvent.press(screen.getByTestId('live-computer-rename'));
    expect(screen.getByTestId('live-computer-name').props.value).toBe('Office laptop 1');
    await fireEvent.changeText(screen.getByTestId('live-computer-name'), '  ');
    await fireEvent.press(screen.getByTestId('live-computer-save'));
    expect(screen.getByTestId('live-computer-problem')).toHaveTextContent(
      'Give the computer a name.',
    );
    expect(a.rename).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('live-computer-name'), ' Kitchen desktop ');
    await fireEvent.press(screen.getByTestId('live-computer-save'));
    await waitFor(() => expect(a.rename).toHaveBeenCalledWith(id(1), 'Kitchen desktop'));
    expect(await screen.findByTestId('live-computer-problem')).toHaveTextContent(
      'That computer isn’t yours anymore. Open Settings again.',
    );
    await fireEvent.press(screen.getByTestId('live-computer-save'));
    await waitFor(() => expect(a.rename).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('live-computer-problem')).toBeNull());
  });

  it('removes one standing by, and every one standing by after asking', async () => {
    const a = actions();
    await render(
      part([computer(1, { working: true }), computer(2), computer(3, { state: 'signed_out' })], a),
    );
    expect(screen.getAllByTestId('live-computer-row')[2]).toHaveTextContent(/Signed out/);
    await fireEvent.press(screen.getAllByTestId('live-computer-remove')[0]!);
    await waitFor(() => expect(a.remove).toHaveBeenCalledWith([id(2)], 'Removed Office laptop 2.'));
    await fireEvent.press(screen.getByTestId('live-computers-clear'));
    expect(
      within(screen.getByTestId('live-computers-clearing')).getByText(
        'Remove the 2 computers standing by? One the extension still runs on comes back the next time it checks in.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-computers-clear-yes'));
    await waitFor(() =>
      expect(a.remove).toHaveBeenLastCalledWith([id(2), id(3)], 'Removed 2 computers.'),
    );
    await waitFor(() => expect(screen.queryByTestId('live-computers-clearing')).toBeNull());
  });

  it('waits for signal', async () => {
    await render(
      part([computer(1, { working: true }), computer(2), computer(3)], actions(), false),
    );
    for (const b of screen.getAllByTestId('live-computer-rename')) expect(b).toBeDisabled();
    expect(screen.getAllByTestId('live-computer-remove')[0]).toBeDisabled();
    expect(screen.getByTestId('live-computers-clear')).toBeDisabled();
  });
});
