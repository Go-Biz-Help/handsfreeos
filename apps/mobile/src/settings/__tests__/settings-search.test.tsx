import { ROLE_PERMISSIONS } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import NotificationSettings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/notifications';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';
import type { RegistrationSnapshot } from '@/push/registration';
import { SettingsSearchResults } from '@/settings/settings-search';

/**
 * Settings search on the phone: a setting the phone has opens its screen at the row, which scrolls into view and
 * flashes; one only the web changes says "Opens on the web" and opens the browser at it, anchor and all; one on
 * Settings itself flashes there. Nothing is asked of the server: it's core's catalogue, searched on the phone.
 */

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
let mockKeptStaff: unknown = null;
jest.mock('@/admin/staff', () => ({
  useStaff: () => ({ staff: null, status: 'ready', error: null, reload: () => undefined }),
  useKeptStaff: () => mockKeptStaff,
}));
const mockRegistration: RegistrationSnapshot = {
  status: 'registered',
  permission: 'granted',
  canAskAgain: true,
  token: 'ExponentPushToken[e2e-1]',
  registeredAt: 1,
  message: null,
};
jest.mock('@/push/hooks', () => ({ usePushRegistration: () => mockRegistration }));

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
      permissions: [...ROLE_PERMISSIONS.owner],
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

beforeEach(() => {
  mockParams = {};
  mockKeptStaff = null;
  jest.mocked(router.push).mockReset();
  jest.mocked(openWeb).mockClear();
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data: sql.includes('FROM workspaces')
      ? [
          {
            settings: JSON.stringify({
              telephony: { quietHours: { enabled: true, start: '21:00', end: '08:00' } },
            }),
          },
        ]
      : sql.includes('push_devices')
        ? [{ n: 1 }]
        : [],
    isLoading: false,
    isFetching: false,
  })) as never);
});

const withBusiness = (children: React.ReactNode) => (
  <BusinessProvider
    value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
  >
    {children}
  </BusinessProvider>
);

describe('settings search on the phone', () => {
  it('opens a setting only the web changes in the browser, at its anchor, with its value', async () => {
    const onFlash = jest.fn();
    await render(withBusiness(<SettingsSearchResults q="quiet hours" onFlash={onFlash} />));
    const row = screen.getByTestId('settings-search-texting.quiet_hours');
    expect(row).toHaveTextContent(/Quiet hours/);
    expect(row).toHaveTextContent(/Opens on the web · 9:00 PM to 8:00 AM/);
    fireEvent.press(row);
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/settings/texting#quiet-hours`);
    expect(router.push).not.toHaveBeenCalled();
    expect(onFlash).not.toHaveBeenCalled();
  });

  it('flashes a setting on Settings itself', async () => {
    const onFlash = jest.fn();
    await render(withBusiness(<SettingsSearchResults q="face id" onFlash={onFlash} />));
    fireEvent.press(screen.getByTestId('settings-search-phone.lock'));
    expect(onFlash).toHaveBeenCalledWith('phone.lock');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens a setting on another of the phone’s screens there, at the row', async () => {
    const onFlash = jest.fn();
    await render(withBusiness(<SettingsSearchResults q="urgent items" onFlash={onFlash} />));
    fireEvent.press(screen.getByTestId('settings-search-notifications.urgent'));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${LONE_STAR}/settings/notifications?setting=notifications.urgent`,
    );
    expect(onFlash).not.toHaveBeenCalled();
  });

  it('lists New support tickets only to someone who answers support', async () => {
    await render(withBusiness(<SettingsSearchResults q="support tickets" onFlash={jest.fn()} />));
    expect(screen.queryByTestId('settings-search-notifications.support_tickets')).toBeNull();
  });

  it('lists New support tickets to support staff, from what the phone already knows', async () => {
    mockKeptStaff = { role: 'agent', permissions: [] };
    await render(withBusiness(<SettingsSearchResults q="support tickets" onFlash={jest.fn()} />));
    expect(screen.getByTestId('settings-search-notifications.support_tickets')).toBeTruthy();
  });

  it('lists Daily agency digest only to an agency, and one business is none', async () => {
    await render(withBusiness(<SettingsSearchResults q="agency digest" onFlash={jest.fn()} />));
    expect(screen.queryByTestId('settings-search-notifications.agency_digest')).toBeNull();
  });

  it('says so when nothing matches', async () => {
    await render(withBusiness(<SettingsSearchResults q="zxqv" onFlash={jest.fn()} />));
    expect(screen.getByTestId('settings-search-none')).toHaveTextContent(
      'No settings match “zxqv”.',
    );
  });

  it('scrolls to the row it was opened at and flashes it', async () => {
    jest.useFakeTimers();
    const content = {};
    const scrollTo = jest.mocked(ScrollView.prototype.scrollTo);
    const inner = ScrollView.prototype as ScrollView & { getInnerViewRef: () => unknown };
    jest.mocked(inner.getInnerViewRef).mockReturnValue(content);
    jest.mocked(View.prototype.measureLayout).mockImplementation((_to, ok) => ok(0, 640, 320, 56));
    scrollTo.mockClear();
    mockParams = { setting: 'notifications.urgent' };
    await render(withBusiness(<NotificationSettings />));
    const row = screen.getByTestId('notification-row-notifications.urgent');
    expect(row.props.className).toContain('bg-accent-soft');
    expect(
      screen.getByTestId('notification-row-notifications.missed_call').props.className,
    ).not.toContain('bg-accent-soft');
    expect(scrollTo).toHaveBeenCalledWith({ y: 640 - 96, animated: true });
    // The flash goes after a moment.
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(
      screen.getByTestId('notification-row-notifications.urgent').props.className,
    ).not.toContain('bg-accent-soft');
    jest.useRealTimers();
  });
});
