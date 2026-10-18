import { PARTNERS_WORDS } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import Settings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Business, Me } from '@/lib/businesses';

/**
 * Settings → Partners has a row under This business for whoever holds Manage partners, while an add-on that uses
 * partners runs here (its permissions are held only then), and for nobody else.
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
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn(async () => ({ data: {}, response: new Response(null, { status: 200 }) })) },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function show(permissions: string[]) {
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC & Roofing',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC & Roofing',
    role: 'admin',
    timezone: 'America/Chicago',
    permissions,
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

it('shows Partners to whoever manages them while partners are on, and opens the screen', async () => {
  await show(['workspace.read', 'outreach.use', 'partners.manage']);
  const row = await screen.findByTestId('setting-partners');
  expect(row).toHaveTextContent(PARTNERS_WORDS.menu, { exact: false });
  await fireEvent.press(row);
  expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/settings/partners`);
});

it('shows no Partners row without Manage partners, nor while no add-on that uses partners runs', async () => {
  await show(['workspace.read', 'outreach.use']);
  expect(await screen.findByTestId('settings')).toBeTruthy();
  expect(screen.queryByTestId('setting-partners')).toBeNull();
  await screen.unmount();

  await show(['workspace.read', 'partners.manage']);
  expect(await screen.findByTestId('settings')).toBeTruthy();
  expect(screen.queryByTestId('setting-partners')).toBeNull();
});
