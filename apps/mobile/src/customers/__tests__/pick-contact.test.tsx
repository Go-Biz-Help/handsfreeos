import {
  PICKED_CONTACT_SOURCE,
  PICKED_CONTACT_WORDS as PC,
  type OnboardingSetupState,
  type PickedContact,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import Customers from '@/app/app/w/[workspaceId]/(tabs)/(more)/customers';
import { CustomersScreen, type OwnScreenProps } from '@/components/onboarding-setup/screens';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change, changes } from '@/changes';
import { pickCustomerFromContacts } from '@/customers/pick-contact';
import type { Me } from '@/lib/businesses';

import HfosPhone from '../../../modules/hfos-phone';

/**
 * Customers picked from the phone's own contacts, one at a time (onboarding plan §8, call 8), with the phone's picker
 * and the queue played by stand-ins: a picked card added as a customer, with no signal needed; someone already a
 * customer found instead of added twice; a contact with no name, a cancelled picker and a phone with no contacts app;
 * and the two places it's offered, the setup's customers stop and the Customers screen's button.
 */

jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return {
    change: jest.fn(),
    newId: jest.fn(() => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    changes: { open: null },
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true, lastOnlineAt: 0 }) }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ROSA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ROSA: PickedContact = {
  firstName: 'Rosa',
  lastName: 'Delgado',
  phones: [
    { number: '(512) 555-0100', label: 'home' },
    { number: '(512) 555-0134', label: 'mobile' },
  ],
  emails: [{ email: 'Rosa@DelgadoDental.com', label: 'work' }],
  addresses: [
    { street: '12 Oak St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'us' },
  ],
};

const pickContact = HfosPhone.pickContact as jest.Mock;
const getAll = jest.fn(async (): Promise<unknown[]> => []);
const copy = changes as unknown as { open: { db: { getAll: typeof getAll } } | null };

/** Rosa, already a customer: her cell is one of her other numbers. */
const ROSA_ON_FILE = {
  id: ROSA_ID,
  first_name: 'Rosa',
  last_name: 'D.',
  email: null,
  phone_e164: null,
  other_phones: '[{"phone":"+15125550134"}]',
  other_emails: null,
};

beforeEach(() => {
  pickContact.mockReset();
  getAll.mockReset();
  getAll.mockResolvedValue([]);
  copy.open = { db: { getAll } };
  jest.mocked(change).mockReset();
  jest.mocked(change).mockResolvedValue({ id: 'cmd-1', queued: true } as never);
  jest.mocked(router.push).mockClear();
  jest
    .spyOn(toast, 'show')
    .mockClear()
    .mockImplementation(() => 1);
  jest
    .spyOn(toast, 'error')
    .mockClear()
    .mockImplementation(() => 1);
});

describe('picking a customer from the phone’s contacts', () => {
  it('adds the card picked as a customer, queued, and on this phone at once', async () => {
    pickContact.mockResolvedValue(ROSA);
    const tx = { execute: jest.fn(async () => undefined) };
    jest.mocked(change).mockImplementation(async (_name, _input, options) => {
      await options?.optimistic?.(tx as never);
      return { id: 'cmd-1', queued: true } as never;
    });

    expect(await pickCustomerFromContacts(LONE_STAR)).toEqual({
      kind: 'added',
      id: NEW_ID,
      name: 'Rosa Delgado',
    });

    expect(getAll).toHaveBeenCalledWith(expect.stringContaining('archived_at IS NULL'), [
      LONE_STAR,
    ]);
    expect(change).toHaveBeenCalledWith(
      'person.create',
      expect.objectContaining({
        workspaceId: LONE_STAR,
        id: NEW_ID,
        firstName: 'Rosa',
        lastName: 'Delgado',
        phone: '+15125550134',
        email: 'rosa@delgadodental.com',
        otherPhones: [{ phone: '+15125550100', label: 'Home' }],
        address: {
          line1: '12 Oak St',
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          country: 'US',
        },
        source: PICKED_CONTACT_SOURCE,
      }),
      expect.anything(),
    );
    // The row the lists read until HandsFreeOS answers: her cell as her number, the source on it.
    const [sql, values] = tx.execute.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO people');
    expect(values.slice(0, 7)).toEqual([
      NEW_ID,
      LONE_STAR,
      'Rosa',
      'Delgado',
      'rosa@delgadodental.com',
      '+15125550134',
      '+15125550134',
    ]);
    expect(values).toContain(PICKED_CONTACT_SOURCE);
  });

  it('finds someone already a customer rather than adding them twice', async () => {
    pickContact.mockResolvedValue(ROSA);
    getAll.mockResolvedValue([ROSA_ON_FILE]);
    expect(await pickCustomerFromContacts(LONE_STAR)).toEqual({
      kind: 'already',
      id: ROSA_ID,
      name: 'Rosa D.',
    });
    expect(change).not.toHaveBeenCalled();
  });

  it('says how to fix a contact with no name, and why nothing can be picked on a phone with no contacts app', async () => {
    pickContact.mockResolvedValue({ phones: [{ number: '(512) 555-0134' }] });
    expect(await pickCustomerFromContacts(LONE_STAR)).toEqual({
      kind: 'failed',
      message: PC.noName,
    });
    pickContact.mockResolvedValue('unavailable');
    expect(await pickCustomerFromContacts(LONE_STAR)).toEqual({
      kind: 'failed',
      message: PC.unavailable,
    });
    expect(change).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is closed, and passes on why a change was refused', async () => {
    pickContact.mockResolvedValue('cancelled');
    expect(await pickCustomerFromContacts(LONE_STAR)).toEqual({ kind: 'cancelled' });
    pickContact.mockResolvedValue(ROSA);
    jest.mocked(change).mockRejectedValue(new Error('This copy is being viewed as a teammate.'));
    expect(await pickCustomerFromContacts(LONE_STAR)).toEqual({
      kind: 'failed',
      message: 'This copy is being viewed as a teammate.',
    });
  });

  it('adds them with no copy to look in, leaving the server to flag a possible duplicate', async () => {
    copy.open = null;
    pickContact.mockResolvedValue({
      name: 'Mike Alvarez',
      phones: [{ number: '512-555-0177', e164: '+15125550177' }],
    });
    expect(await pickCustomerFromContacts(LONE_STAR)).toMatchObject({
      kind: 'added',
      name: 'Mike Alvarez',
    });
    expect(change).toHaveBeenCalledWith(
      'person.create',
      expect.objectContaining({ phone: '+15125550177', firstName: 'Mike', lastName: 'Alvarez' }),
      expect.anything(),
    );
  });
});

describe('the setup’s customers stop', () => {
  function props(can = true): OwnScreenProps {
    return {
      workspaceId: LONE_STAR,
      state: { businessName: 'Lone Star HVAC' } as unknown as OnboardingSetupState,
      answers: { customersIn: 'phone' } as OwnScreenProps['answers'],
      set: jest.fn(),
      setAi: jest.fn(),
      problems: {},
      calls: {} as OwnScreenProps['calls'],
      name: 'Ava',
      can: () => can,
      refresh: jest.fn(async () => undefined),
    } as OwnScreenProps;
  }

  it('picks customers one at a time and lists who came in, and who was there already', async () => {
    await render(<CustomersScreen {...props()} />);
    expect(screen.getByTestId('setup-customers-contacts')).toHaveTextContent(PC.onlyPicked, {
      exact: false,
    });
    expect(screen.getByTestId('setup-customers-pick')).toHaveTextContent(PC.pick);

    pickContact.mockResolvedValueOnce(ROSA);
    await fireEvent.press(screen.getByTestId('setup-customers-pick'));
    await waitFor(() => expect(screen.getByTestId(`setup-picked-${NEW_ID}`)).toBeTruthy());
    expect(screen.getByTestId(`setup-picked-${NEW_ID}`)).toHaveTextContent('Rosa Delgado', {
      exact: false,
    });
    expect(screen.getByTestId(`setup-picked-${NEW_ID}`)).toHaveTextContent(PC.addedTag, {
      exact: false,
    });
    expect(screen.getByTestId('setup-customers-pick')).toHaveTextContent(PC.pickAnother);

    pickContact.mockResolvedValueOnce({ name: 'Rosa', phones: [{ number: '512 555 0134' }] });
    getAll.mockResolvedValueOnce([ROSA_ON_FILE]);
    await fireEvent.press(screen.getByTestId('setup-customers-pick'));
    await waitFor(() => expect(screen.getByTestId(`setup-picked-${ROSA_ID}`)).toBeTruthy());
    expect(screen.getByTestId(`setup-picked-${ROSA_ID}`)).toHaveTextContent(PC.alreadyTag, {
      exact: false,
    });
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('says why a contact couldn’t come in', async () => {
    await render(<CustomersScreen {...props()} />);
    pickContact.mockResolvedValueOnce({});
    await fireEvent.press(screen.getByTestId('setup-customers-pick'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(PC.noName));
    expect(screen.queryByTestId('setup-customers-picked')).toBeNull();
  });

  it('offers no picking to someone who can’t add customers', async () => {
    await render(<CustomersScreen {...props(false)} />);
    expect(screen.queryByTestId('setup-customers-pick')).toBeNull();
  });
});

describe('the Customers screen’s button', () => {
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
  const wrap = (node: React.ReactNode, business = me.businesses[0]!) => (
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      {node}
    </BusinessProvider>
  );

  it('adds a customer picked from the contacts, and opens them from the note', async () => {
    await render(wrap(<Customers />));
    pickContact.mockResolvedValueOnce(ROSA);
    await fireEvent.press(screen.getByLabelText(PC.addFromContacts));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    const [message, options] = jest.mocked(toast.show).mock.calls[0]!;
    expect(message).toBe(PC.added('Rosa Delgado'));
    options?.action?.onPress();
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/customers/people/${NEW_ID}`);
  });

  it('says when they’re already a customer', async () => {
    await render(wrap(<Customers />));
    pickContact.mockResolvedValueOnce(ROSA);
    getAll.mockResolvedValueOnce([ROSA_ON_FILE]);
    await fireEvent.press(screen.getByTestId('customers-pick'));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(jest.mocked(toast.show).mock.calls[0]![0]).toBe(PC.already('Rosa D.'));
    expect(change).not.toHaveBeenCalled();
  });

  it('isn’t there for someone who can only look', async () => {
    await render(
      wrap(<Customers />, { ...me.businesses[0]!, role: 'member', permissions: ['records.read'] }),
    );
    expect(screen.queryByTestId('customers-pick')).toBeNull();
  });
});
