import { WIDGET_EMPTY_WORDS, WIDGET_SCREEN_WORDS } from '@hfos/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import WidgetsSettings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/widgets';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';

import { forgetWidgets, onWidgetsRefresh, storeWidgets, widgetsHideNames } from '../store';
import { DATA, NOW } from './fixture';

/**
 * Settings → Home-screen widgets (docs/phone-widgets.md): the steps to add one, Hide names on widgets, what's on them
 * now, and Update now.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));

const DALE = '22222222-2222-4222-8222-222222222222';
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [
    {
      id: DATA.business.id,
      name: 'Lone Star HVAC',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC', role: 'owner' }],
  fetchedAt: 0,
};

const inBusiness = (children: React.ReactNode) => (
  <BusinessProvider
    value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
  >
    {children}
  </BusinessProvider>
);

beforeEach(() => forgetWidgets());

describe('Settings → Home-screen widgets', () => {
  it('gives the steps, and says nothing is on them yet', async () => {
    await render(inBusiness(<WidgetsSettings />));
    expect(screen.getByText(WIDGET_SCREEN_WORDS.howIphone[0]!)).toBeTruthy();
    expect(screen.getByText(WIDGET_SCREEN_WORDS.statusNone)).toBeTruthy();
    expect(screen.queryByText(WIDGET_EMPTY_WORDS.signedOut)).toBeNull();
  });

  it('says which business the widgets show once the app has saved them', async () => {
    storeWidgets(DATA, NOW);
    await render(inBusiness(<WidgetsSettings />));
    expect(screen.getByTestId('widgets-status')).toHaveTextContent(
      /Showing Lone Star HVAC, updated/,
    );
  });

  it('turns Hide names on for this person', async () => {
    await render(inBusiness(<WidgetsSettings />));
    await act(async () => fireEvent.press(screen.getByTestId('widgets-hide-names')));
    expect(widgetsHideNames(DALE)).toBe(true);
  });

  it('builds the copy again on Update now', async () => {
    const refresh = jest.fn(async () => undefined);
    const off = onWidgetsRefresh(refresh);
    await render(inBusiness(<WidgetsSettings />));
    await act(async () => fireEvent.press(screen.getByTestId('widgets-update')));
    off();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
