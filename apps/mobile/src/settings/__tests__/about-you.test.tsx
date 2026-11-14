import { ABOUT_YOU_WORDS as W } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import AboutYou from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/about-you';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import type { Me } from '@/lib/businesses';

/**
 * About you on the phone (docs/outreach.md, decision 165): one box in the person's own words, read and saved with
 * signal and never kept in the phone's copy, with who sees it and how the AI uses it said beside it. Emptied and
 * saved, it's cleared.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
const mockPost = jest.fn();
jest.mock('@/lib/api', () => ({
  api: { POST: (...a: unknown[]) => mockPost(...a) },
  unwrap: (r: unknown) => r,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};
const draw = () =>
  render(
    <BusinessProvider
      value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
    >
      <AboutYou />
    </BusinessProvider>,
  );

const MINE = 'I grew up in Greenville. Big Braves fan.';

beforeEach(() => {
  mockOnline = true;
  mockPost.mockReset();
  jest.mocked(toast.show).mockClear();
  jest.mocked(toast.error).mockClear();
});

describe('About you, on the phone', () => {
  it('shows what they said, saves a change whole, and clears it when emptied', async () => {
    mockPost.mockImplementation(async (path: string, o: { body: { about?: string } }) =>
      path === '/v1/queries/user_about.get'
        ? { about: MINE, updatedAt: '2026-11-14T18:00:00.000Z' }
        : { filled: !!o.body.about, changed: true },
    );
    await draw();
    await waitFor(() => expect(screen.getByTestId('about-you-box').props.value).toBe(MINE));
    // Who sees it, and how it's used, are said on the screen.
    expect(screen.getByText(W.private)).toBeTruthy();
    expect(screen.getByText(W.how)).toBeTruthy();
    // Nothing changed yet, so nothing to save.
    expect(screen.getByTestId('about-you-save')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('about-you-box'), `${MINE} Dad of two.  `);
    await fireEvent.press(screen.getByTestId('about-you-save'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/v1/commands/user_about.set', {
        body: { about: `${MINE} Dad of two.` },
      }),
    );
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith(W.saved));
    expect(screen.getByTestId('about-you-save')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('about-you-box'), '');
    await fireEvent.press(screen.getByTestId('about-you-save'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenLastCalledWith('/v1/commands/user_about.set', {
        body: { about: '' },
      }),
    );
    await waitFor(() => expect(toast.show).toHaveBeenLastCalledWith(W.cleared));
  });

  it('says why a save was refused, in the refusal’s own words, and keeps what they typed', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === '/v1/queries/user_about.get') return { about: '', updatedAt: null };
      throw new Error(W.tooLong);
    });
    await draw();
    await waitFor(() => expect(screen.getByTestId('about-you-box').props.editable).toBe(true));
    await fireEvent.changeText(screen.getByTestId('about-you-box'), MINE);
    await fireEvent.press(screen.getByTestId('about-you-save'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(W.tooLong));
    expect(screen.getByTestId('about-you-box').props.value).toBe(MINE);
    expect(screen.getByTestId('about-you-save')).not.toBeDisabled();
  });

  it('needs signal: with none it says so, and there’s nothing to type into or press', async () => {
    mockOnline = false;
    mockPost.mockRejectedValue(new Error('offline'));
    await draw();
    expect(await screen.findByTestId('about-you-needs-signal')).toHaveTextContent(W.needsSignal);
    expect(screen.getByTestId('about-you-box').props.editable).toBe(false);
    expect(screen.queryByTestId('about-you-retry')).toBeNull();
    expect(screen.getByTestId('about-you-save')).toBeDisabled();
  });

  it('offers to try again when the read failed with signal, and reads it then', async () => {
    mockPost.mockRejectedValueOnce(new Error('busy'));
    mockPost.mockResolvedValueOnce({ about: MINE, updatedAt: '2026-11-14T18:00:00.000Z' });
    await draw();
    await fireEvent.press(await screen.findByTestId('about-you-retry'));
    await waitFor(() => expect(screen.getByTestId('about-you-box').props.value).toBe(MINE));
    expect(screen.queryByTestId('about-you-needs-signal')).toBeNull();
  });
});
