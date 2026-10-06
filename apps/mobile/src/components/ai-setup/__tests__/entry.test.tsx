import { AI_SETUP_WORDS, MORE_WORDS } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import More from '@/app/app/w/[workspaceId]/(tabs)/(more)/more';
import AiTest from '@/app/app/w/[workspaceId]/ai-test';
import { BusinessProvider } from '@/components/shell/business-context';
import { TEAMMATE_SQL } from '@/home/queries';
import type { Business, Me } from '@/lib/businesses';

/**
 * Where quick setup opens from on the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8, §10): More, for
 * whoever manages the teammate while there isn't one, with the test console and "Run quick setup again" in its place
 * once there is; and the test console itself, before there's a teammate to test. Getting started's AI step is in
 * onboarding's tests.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/components/shell/up-to-date', () => ({ UpToDate: () => null }));
jest.mock('@/components/home/approvals-count', () => ({ ApprovalsCount: () => null }));
jest.mock('@/ideas/whats-new-signal', () => ({ useWhatsNewUnseen: () => 0 }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AVA = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Ava', status: 'off' };

/** The phone's copy of the business's teammate: none, Ava, or not read yet. */
function teammates(rows: (typeof AVA)[], isLoading = false) {
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data: sql === TEAMMATE_SQL ? rows : [],
    isLoading: sql === TEAMMATE_SQL && isLoading,
    isFetching: false,
  })) as unknown as typeof useQuery);
}

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

beforeEach(() => {
  jest.clearAllMocks();
  teammates([]);
});

it('offers an owner quick setup in More while there’s no teammate, then the test console and running it again', async () => {
  await show(<More />, 'owner');
  const row = await screen.findByTestId('more-set-up-teammate');
  expect(row).toHaveTextContent(MORE_WORDS.setUpTeammate, { exact: false });
  expect(screen.queryByTestId('more-test-console')).toBeNull();
  expect(screen.queryByTestId('more-run-quick-setup')).toBeNull();
  await fireEvent.press(row);
  expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ai-setup`);
  await screen.unmount();

  jest.mocked(router.push).mockClear();
  teammates([AVA]);
  await show(<More />, 'owner');
  expect(await screen.findByTestId('more-test-console')).toBeTruthy();
  expect(screen.queryByTestId('more-set-up-teammate')).toBeNull();
  // Quick setup again starts from what's saved, and shows what will change before saving.
  const again = screen.getByTestId('more-run-quick-setup');
  expect(again).toHaveTextContent(AI_SETUP_WORDS.runAgain, { exact: false });
  await fireEvent.press(again);
  expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ai-setup`);
});

it('offers it neither before the phone has read the teammate nor to someone who doesn’t manage it', async () => {
  // Not read yet: no row that would be gone a moment later.
  teammates([], true);
  await show(<More />, 'owner');
  expect(await screen.findByTestId('more-settings')).toBeTruthy();
  expect(screen.queryByTestId('more-set-up-teammate')).toBeNull();
  await screen.unmount();

  teammates([]);
  await show(<More />, 'member', ['inbox.view']);
  expect(await screen.findByTestId('more-settings')).toBeTruthy();
  expect(screen.queryByTestId('more-set-up-teammate')).toBeNull();
  await screen.unmount();

  teammates([AVA]);
  await show(<More />, 'member', ['inbox.view']);
  expect(await screen.findByTestId('more-settings')).toBeTruthy();
  expect(screen.queryByTestId('more-run-quick-setup')).toBeNull();
});

it('sends the test console to quick setup while there’s no teammate to test', async () => {
  await show(<AiTest />, 'owner');
  expect(await screen.findByTestId('ai-test-unavailable')).toHaveTextContent(
    'Set up your AI teammate first.',
    { exact: false },
  );
  await fireEvent.press(screen.getByTestId('ai-test-set-up'));
  expect(router.replace).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ai-setup`);
});
