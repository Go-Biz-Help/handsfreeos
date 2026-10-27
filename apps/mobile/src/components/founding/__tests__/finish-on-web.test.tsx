import { FOUNDING_PICK_WORDS as W } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { FinishOnTheWeb } from '@/components/founding/finish-on-web';
import { BusinessProvider } from '@/components/shell/business-context';
import { loadMe, type Business, type Me } from '@/lib/businesses';

/**
 * A business made while founding spots are on sale is paid for on the web before it opens (20261027012700). The
 * phone says so with no price and no link, and checks again when asked.
 */

jest.mock('@/lib/businesses', () => ({ loadMe: jest.fn(() => Promise.resolve()) }));
const mockSheet = jest.fn((_: { open: boolean }) => null);
jest.mock('@/components/shell/sign-out-sheet', () => ({
  SignOutSheet: (props: { open: boolean }) => mockSheet(props),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const business = (id: string, name: string, needsPlan: boolean): Business => ({
  id,
  name,
  organizationId: 'org',
  organizationName: name,
  role: 'owner',
  timezone: 'America/Chicago',
  needsPlan,
});

async function draw(businesses: readonly Business[], openSwitcher = jest.fn()) {
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarplumbing.test', fullName: 'Dale Porter' },
    businesses,
    organizations: [{ id: 'org', name: 'Lone Star Plumbing', role: 'owner' }],
    fetchedAt: 0,
  };
  await render(
    <BusinessProvider value={{ userId: DALE, me, business: businesses[0]!, openSwitcher }}>
      <FinishOnTheWeb />
    </BusinessProvider>,
  );
  return openSwitcher;
}

beforeEach(() => jest.clearAllMocks());

it('sends the business to the web with no price and no link', async () => {
  await draw([business(LONE_STAR, 'Lone Star Plumbing', true)]);
  expect(screen.getByTestId('finish-on-web-title')).toHaveTextContent(W.phoneTitle);
  expect(screen.getByTestId('finish-on-web-body')).toHaveTextContent(
    W.phoneBody('Lone Star Plumbing'),
  );
  // Nothing on the screen sells: no price, no plan, no way to the payment page.
  expect(screen.queryByText(/\$|a year|a month|pay/i)).toBeNull();
  // Only one business: nothing else to open.
  expect(screen.queryByTestId('finish-on-web-switch')).toBeNull();
});

it('checks again once it’s been paid for on the web', async () => {
  await draw([business(LONE_STAR, 'Lone Star Plumbing', true)]);
  await fireEvent.press(screen.getByTestId('finish-on-web-check'));
  await waitFor(() => expect(loadMe).toHaveBeenCalledWith(DALE));
});

it('opens another business, or signs out', async () => {
  const openSwitcher = await draw([
    business(LONE_STAR, 'Lone Star Plumbing', true),
    business(OTHER, 'Hill Country Roofing', false),
  ]);
  await fireEvent.press(screen.getByTestId('finish-on-web-switch'));
  expect(openSwitcher).toHaveBeenCalled();
  expect(mockSheet).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
  await fireEvent.press(screen.getByTestId('finish-on-web-sign-out'));
  expect(mockSheet).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
});
