import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import More from '@/app/app/w/[workspaceId]/(tabs)/(more)/more';
import Settings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Business, Me } from '@/lib/businesses';

import { ADDON_PHONE_WORDS } from '../words';

/**
 * Add-ons is a place of its own in More, beside Ideas and Get help, not a setting (the owner's decision,
 * 2026-09-28). Its row is for whoever may install add-ons (owners and admins, `addons.manage`); nobody else sees it,
 * and Settings no longer has one. Its screen reads nothing until it's opened.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
  usePowerSync: () => ({ getOptional: jest.fn(async () => null) }),
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/components/shell/up-to-date', () => ({ UpToDate: () => null }));
jest.mock('@/components/home/approvals-count', () => ({ ApprovalsCount: () => null }));
jest.mock('@/ideas/whats-new-signal', () => ({ useWhatsNewUnseen: () => 0 }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function show(screenOf: React.ReactElement, role: Business['role'], permissions?: string[]) {
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
      {screenOf}
    </BusinessProvider>,
  );
}

beforeEach(() => jest.clearAllMocks());

it('shows an owner and an admin Add-ons in More, beside Ideas and Get help, and opens the screen', async () => {
  await show(<More />, 'owner');
  const row = await screen.findByTestId('more-add-ons');
  expect(row).toHaveTextContent(ADDON_PHONE_WORDS.title, { exact: false });
  expect(screen.getByTestId('more-ideas')).toBeTruthy();
  expect(screen.getByTestId('more-get-help')).toBeTruthy();
  await fireEvent.press(row);
  expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/add-ons`);
  await screen.unmount();

  await show(<More />, 'admin');
  expect(await screen.findByTestId('more-add-ons')).toBeTruthy();
});

it('shows no Add-ons row to a member, nor to an admin the business took add-ons away from', async () => {
  await show(<More />, 'member');
  expect(await screen.findByTestId('more-ideas')).toBeTruthy();
  expect(screen.queryByTestId('more-add-ons')).toBeNull();
  await screen.unmount();

  // addons.manage is one a business sets per role and per person (0106).
  await show(<More />, 'admin', ['workspace.read', 'money.read', 'money.manage']);
  expect(await screen.findByTestId('more-ideas')).toBeTruthy();
  expect(screen.queryByTestId('more-add-ons')).toBeNull();
});

it('keeps Add-ons out of Settings, where the balance stays', async () => {
  await show(<Settings />, 'owner');
  expect(await screen.findByTestId('settings')).toBeTruthy();
  expect(screen.queryByTestId('setting-add-ons')).toBeNull();
  expect(screen.getByTestId('setting-usage')).toBeTruthy();
});
