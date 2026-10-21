import { ROLE_PERMISSIONS } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { AppBar } from '@/components/shell/app-bar';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';
import type { PhoneView } from '@/view-as/state';
import { searchScreenHref } from '@/search/href';
import { SearchEverythingRow } from '@/search/rows';

/**
 * Where the phone's Search everything opens from (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, Search 9): the Search
 * button in the top bar of a business's own screens, and "Search everything for “q”" at the end of the Contacts and
 * Inbox boxes' results. What's typed goes only into the app's own address.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
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
      permissions: [...ROLE_PERMISSIONS.owner],
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const inBusiness = (children: React.ReactNode, viewing: PhoneView | null = null) => (
  <BusinessProvider
    value={{
      userId: DALE,
      me,
      business: me.businesses[0]!,
      openSwitcher: () => undefined,
      viewing,
    }}
  >
    {children}
  </BusinessProvider>
);

beforeEach(() => jest.clearAllMocks());

describe('Search everything’s way in on the phone', () => {
  it('puts Search after Ask HandsFreeOS where the business mark leads, and opens the search screen', async () => {
    await render(inBusiness(<AppBar title="Home" />));
    const button = screen.getByTestId('app-bar-search');
    expect(button).toHaveProp('accessibilityLabel', 'Search everything');
    await fireEvent.press(button);
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/search`);
  });

  it('leaves it off a screen opened from another, unless the screen asks for it', async () => {
    const { rerender } = await render(inBusiness(<AppBar title="Customer" leading="back" />));
    expect(screen.queryByTestId('app-bar-search')).toBeNull();
    await rerender(inBusiness(<AppBar title="Contacts" leading="back" search />));
    expect(screen.getByTestId('app-bar-search')).toBeTruthy();
    await rerender(inBusiness(<AppBar title="Home" search={false} />));
    expect(screen.queryByTestId('app-bar-search')).toBeNull();
  });

  it('ends the Contacts and Inbox results with Search everything for what was typed, once there is enough', async () => {
    const { rerender } = await render(
      <SearchEverythingRow workspaceId={LONE_STAR} q="d" testID="everything" />,
    );
    expect(screen.queryByTestId('everything')).toBeNull();
    await rerender(
      <SearchEverythingRow workspaceId={LONE_STAR} q="  dana smith " testID="everything" />,
    );
    expect(screen.getByTestId('everything')).toHaveTextContent(
      'Search everything for “dana smith”',
    );
    await fireEvent.press(screen.getByTestId('everything'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/search?q=dana%20smith`);
  });

  it('keeps what was typed in the app’s own address, escaped and cut to 120 characters', () => {
    expect(searchScreenHref(LONE_STAR)).toBe(`/app/w/${LONE_STAR}/search`);
    expect(searchScreenHref(LONE_STAR, 'jo & sam #2')).toBe(
      `/app/w/${LONE_STAR}/search?q=jo%20%26%20sam%20%232`,
    );
    expect(searchScreenHref(LONE_STAR, 'x'.repeat(200))).toBe(
      `/app/w/${LONE_STAR}/search?q=${'x'.repeat(120)}`,
    );
  });
});
