import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import Settings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Business, Me } from '@/lib/businesses';

import { ADDON_PHONE_WORDS } from '../words';

/**
 * Settings → Add-ons is for whoever may install add-ons (owners and admins, `addons.manage`); nobody else sees the
 * row. Its screen reads nothing until it's opened.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/components/shell/up-to-date', () => ({ UpToDate: () => null }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function show(role: Business['role'], permissions?: string[]) {
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC & Roofing',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC & Roofing',
    role,
    timezone: 'America/Chicago',
    ...(permissions ? { permissions } : {}),
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <Settings />
    </BusinessProvider>,
  );
}

beforeEach(() => jest.clearAllMocks());

it('shows an owner and an admin the Add-ons row, and opens the screen', async () => {
  await show('owner');
  const row = await screen.findByTestId('setting-add-ons');
  expect(row).toHaveTextContent(ADDON_PHONE_WORDS.title, { exact: false });
  await fireEvent.press(row);
  expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/settings/add-ons`);
  await screen.unmount();

  await show('admin');
  expect(await screen.findByTestId('setting-add-ons')).toBeTruthy();
});

it('shows no Add-ons row to a member, nor to an admin the business took add-ons away from', async () => {
  await show('member');
  expect(await screen.findByTestId('settings')).toBeTruthy();
  expect(screen.queryByTestId('setting-add-ons')).toBeNull();
  await screen.unmount();

  // addons.manage is one a business sets per role and per person (0106).
  await show('admin', ['workspace.read', 'money.read', 'money.manage']);
  expect(await screen.findByTestId('settings')).toBeTruthy();
  expect(screen.queryByTestId('setting-add-ons')).toBeNull();
  // The balance is still theirs, in the same group.
  expect(screen.getByTestId('setting-usage')).toBeTruthy();
});
