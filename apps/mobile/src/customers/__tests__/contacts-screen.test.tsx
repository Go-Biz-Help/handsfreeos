import { useQuery } from '@powersync/react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import Contacts from '@/app/app/w/[workspaceId]/(tabs)/(more)/customers';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';

import { CLIENT_MARKS_SQL, COMPANIES_SQL, PEOPLE_SQL } from '../queries';

/**
 * Contacts on the phone: everyone, only the leads or only the clients, from the marks the database keeps (the phone's
 * copy lacks most of what decides it), with a Client badge beside each client.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true }) }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
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

const person = (id: string, first: string, company: string | null = null) => ({
  id,
  workspace_id: LONE_STAR,
  first_name: first,
  last_name: 'Lopez',
  company_id: company,
  archived_at: null,
  created_at: '2026-09-01T12:00:00.000Z',
  updated_at: '2026-09-01T12:00:00.000Z',
});
const company = (id: string, name: string) => ({
  id,
  workspace_id: LONE_STAR,
  name,
  archived_at: null,
  created_at: '2026-09-01T12:00:00.000Z',
  updated_at: '2026-09-01T12:00:00.000Z',
});

beforeEach(() => {
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data:
      sql === PEOPLE_SQL
        ? [person('p-ana', 'Ana', 'c-bay'), person('p-ben', 'Ben')]
        : sql === COMPANIES_SQL
          ? [company('c-bay', 'Bayou Bistro'), company('c-cove', 'Cove Dental')]
          : sql === CLIENT_MARKS_SQL
            ? [{ id: 'p-ana' }, { id: 'c-bay' }]
            : [],
    isLoading: false,
    isFetching: false,
  })) as never);
});

const renderContacts = () =>
  render(
    <BusinessProvider
      value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
    >
      <Contacts />
    </BusinessProvider>,
  );

const names = () => screen.getAllByTestId('customer-name').map((n) => n.props.children);

describe('Contacts on the phone', () => {
  it('shows everyone, with a Client badge beside each client', async () => {
    await renderContacts();
    expect(names()).toEqual(['Ana Lopez', 'Ben Lopez']);
    expect(screen.getByTestId('customer-row-p-ana')).toHaveTextContent(/Client/);
    expect(screen.getByTestId('customer-row-p-ben')).not.toHaveTextContent(/Client/);
  });

  it('narrows to the clients or the leads', async () => {
    await renderContacts();
    await fireEvent.press(screen.getByTestId('customers-standing-client'));
    expect(names()).toEqual(['Ana Lopez']);
    await fireEvent.press(screen.getByTestId('customers-standing-lead'));
    expect(names()).toEqual(['Ben Lopez']);
    await fireEvent.press(screen.getByTestId('customers-standing-all'));
    expect(names()).toEqual(['Ana Lopez', 'Ben Lopez']);
  });

  it('narrows companies the same way, and says so when none is left', async () => {
    await renderContacts();
    await fireEvent.press(screen.getByTestId('customers-companies'));
    await fireEvent.press(screen.getByTestId('customers-standing-lead'));
    expect(screen.getByTestId('company-row-c-cove')).toBeTruthy();
    expect(screen.queryByTestId('company-row-c-bay')).toBeNull();
    jest.mocked(useQuery).mockImplementation(((sql: string) => ({
      data: sql === PEOPLE_SQL ? [person('p-ben', 'Ben')] : [],
      isLoading: false,
      isFetching: false,
    })) as never);
    await renderContacts();
    await fireEvent.press(screen.getByTestId('customers-standing-client'));
    expect(screen.getByText(/^No clients here yet\./)).toBeTruthy();
  });
});
