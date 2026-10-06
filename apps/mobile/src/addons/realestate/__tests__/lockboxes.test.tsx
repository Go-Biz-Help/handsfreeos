import { render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { api } from '@/lib/api';

import { ShowingLockboxes } from '../lockboxes';

/**
 * A listing's lockboxes on the phone (board 98): kind, place and serial, who opened them, and never the code. They
 * come from HandsFreeOS while there's signal, and say so when there isn't.
 */

let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TZ = 'America/Chicago';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const LIST = {
  lockboxes: [
    {
      id: id(1),
      kind: 'sentrilock',
      kindLabel: 'SentriLock',
      place: 'Front door',
      serial: '31-118204',
      hasCode: true,
      codeSetAt: '2026-10-01T15:00:00.000Z',
    },
    {
      id: id(2),
      kind: 'combination',
      kindLabel: 'Combination lockbox',
      place: 'Side gate',
      serial: null,
      hasCode: true,
      codeSetAt: '2026-10-01T15:00:00.000Z',
    },
  ],
  openings: [
    {
      id: id(11),
      vendor: 'sentrilock',
      openedAt: '2026-10-05T19:14:00.000Z',
      openedBy: 'Ana Ruiz',
      company: 'Compass',
      lockboxId: id(1),
      showingId: id(21),
      booked: true,
    },
    {
      id: id(12),
      vendor: 'supra',
      openedAt: '2026-10-06T00:48:00.000Z',
      openedBy: 'Jo Kim',
      company: 'Keller Williams',
      lockboxId: id(1),
      showingId: null,
      booked: false,
    },
  ],
};

// The API client's own types are too deep for jest.mocked.
const post = api.POST as unknown as jest.Mock;

beforeEach(() => {
  mockOnline = true;
  post.mockReset();
});

describe('lockboxes on the phone', () => {
  it('lists each lockbox and who opened them, and says the code never comes onto phones', async () => {
    post.mockResolvedValue({ data: LIST });
    await render(
      <ShowingLockboxes workspaceId={WS} dealId={DEAL} today="2026-10-05" timeZone={TZ} />,
    );
    await waitFor(() => expect(screen.getByText('Lockboxes  2')).toBeTruthy());
    expect(post).toHaveBeenCalledWith('/v1/queries/realestate.lockbox.list', {
      body: { workspaceId: WS, dealId: DEAL },
    });
    expect(screen.getByText('SentriLock · front door')).toBeTruthy();
    expect(screen.getByText('Serial 31-118204 · code kept locked')).toBeTruthy();
    expect(screen.getByText('Combination lockbox · side gate')).toBeTruthy();
    expect(screen.getByText('Code kept locked')).toBeTruthy();
    expect(screen.getByTestId('re-lockbox-never')).toBeTruthy();
    expect(screen.getByText(/The code never comes onto phones/)).toBeTruthy();
    expect(screen.getByText('Who opened them')).toBeTruthy();
    expect(screen.getByText('Today 2:14 PM · Ana Ruiz')).toBeTruthy();
    expect(screen.getByText('Compass · fits a showing')).toBeTruthy();
    expect(screen.getByText('Today 7:48 PM · Jo Kim')).toBeTruthy();
    expect(screen.getByText('Keller Williams · no showing booked')).toBeTruthy();
    // Nothing on the screen offers the code.
    expect(screen.queryByText('Show code')).toBeNull();
  });

  it('says a listing with none yet how a code goes out', async () => {
    post.mockResolvedValue({ data: { lockboxes: [], openings: [] } });
    await render(
      <ShowingLockboxes workspaceId={WS} dealId={DEAL} today="2026-10-05" timeZone={TZ} />,
    );
    await waitFor(() => expect(screen.getByText('Lockboxes  0')).toBeTruthy());
    expect(screen.getByText(/None yet. Add the listing’s lockbox/)).toBeTruthy();
    expect(screen.queryByText('Who opened them')).toBeNull();
  });

  it('waits for signal when there isn’t any', async () => {
    mockOnline = false;
    post.mockRejectedValue(new Error('Network request failed'));
    await render(
      <ShowingLockboxes workspaceId={WS} dealId={DEAL} today="2026-10-05" timeZone={TZ} />,
    );
    await waitFor(() => expect(screen.getByText('Lockboxes load with signal.')).toBeTruthy());
    expect(screen.getByTestId('re-lockboxes-signal')).toBeTruthy();
  });
});
