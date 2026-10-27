import { useQuery } from '@powersync/react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { CALENDARS_SQL, PEOPLE_SQL } from '@/calendar/queries';
import { NewAppointmentSheet } from '@/components/calendar/new-appointment';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change, changes } from '@/changes';
import type { Me } from '@/lib/businesses';

/**
 * New appointment's search for who it's for, when it finds nobody (React Native Testing Library, with the copy and
 * the queue played by stand-ins): "Add “Dana Smith” as a new contact" opens New contact in the sheet with the name
 * typed, a mistyped number is caught before anything is kept, and the new customer is the one the visit is for, the
 * time asked for waiting on them being added. A number that's already a customer's offers them instead, or adds the
 * new one anyway; and someone who may not add customers isn't offered it.
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
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true, lastOnlineAt: 0 }) }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MIKE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CALENDAR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const MIKE = {
  id: MIKE_ID,
  first_name: 'Mike',
  last_name: 'Johnson',
  email: null,
  phone_e164: '+17135550142',
  city: 'Houston',
  address_line1: '5107 Evergreen St',
  address_line2: null,
  state: 'TX',
  postal_code: '77401',
  other_emails: null,
  other_phones: null,
  other_addresses: null,
};

const meWith = (business: Partial<Me['businesses'][number]> = {}): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
      ...business,
    },
  ],
  fetchedAt: 0,
});

function sheet(me: Me = meWith()) {
  return render(
    <BusinessProvider
      value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
    >
      <NewAppointmentSheet
        open
        onClose={() => undefined}
        date="2026-10-28"
        timeZone="America/Chicago"
        person={null}
      />
    </BusinessProvider>,
  );
}

const getAll = jest.fn(async (): Promise<unknown[]> => []);
const copy = changes as unknown as { open: { db: { getAll: typeof getAll } } | null };

beforeEach(() => {
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data:
      sql === CALENDARS_SQL
        ? [
            {
              id: CALENDAR_ID,
              name: 'Service calls',
              color: '#2563eb',
              config: null,
              revision: 1,
            },
          ]
        : sql === PEOPLE_SQL
          ? [MIKE]
          : [],
    isLoading: false,
    isFetching: false,
  })) as never);
  getAll.mockReset();
  getAll.mockResolvedValue([MIKE]);
  copy.open = { db: { getAll } };
  jest.mocked(change).mockReset();
  jest
    .mocked(change)
    .mockImplementation(async (name) =>
      name === 'person.create'
        ? ({ id: 'cmd-person', queued: true } as never)
        : ({ id: 'cmd-visit', queued: true } as never),
    );
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('a search that finds nobody', () => {
  it('adds them as a new contact, and the visit is theirs once they are', async () => {
    await sheet();
    // Somebody on file: no offer to add anyone.
    await fireEvent.changeText(screen.getByTestId('new-appointment-customer-search'), 'Mike');
    expect(screen.getByTestId(`new-appointment-customer-${MIKE_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('new-appointment-nobody')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('new-appointment-customer-search'), 'Dana Smith');
    expect(screen.getByTestId('new-appointment-nobody')).toHaveTextContent(
      'No one matches “Dana Smith”.Add “Dana Smith” as a new contact',
    );
    await fireEvent.press(screen.getByTestId('new-appointment-add-contact'));
    expect(screen.getByTestId('new-contact-name').props.value).toBe('Dana Smith');

    // A number that can't be one is caught here, before anything is kept for later.
    await fireEvent.changeText(screen.getByTestId('new-contact-phone'), '555-01');
    await fireEvent.press(screen.getByTestId('new-contact-save'));
    await waitFor(() =>
      expect(screen.getByTestId('new-contact-problem')).toHaveTextContent(
        'Enter a valid phone number, or leave it blank.',
      ),
    );
    expect(change).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('new-contact-phone'), '(713) 555-0199');
    await fireEvent.press(screen.getByTestId('new-contact-save'));
    await waitFor(() =>
      expect(screen.getByTestId('new-appointment-for')).toHaveTextContent('For Dana Smith'),
    );
    expect(change).toHaveBeenCalledWith(
      'person.create',
      {
        workspaceId: LONE_STAR,
        id: NEW_ID,
        firstName: 'Dana',
        lastName: 'Smith',
        phone: '+17135550199',
        email: null,
        otherPhones: [],
        otherEmails: [],
        otherAddresses: [],
      },
      expect.objectContaining({ optimistic: expect.any(Function) }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Smith added.');

    // The time asked for is Dana's, and waits for Dana to be added first.
    await fireEvent.press(screen.getByTestId('ask-for-this-time'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(
        'appointment.create',
        expect.objectContaining({ personId: NEW_ID, calendarId: CALENDAR_ID }),
        { dependsOn: ['cmd-person'] },
      ),
    );
  });

  it('starts New contact with a number in Phone, and offers whoever already has it', async () => {
    await sheet();
    await fireEvent.changeText(
      screen.getByTestId('new-appointment-customer-search'),
      '281 555 0111',
    );
    await fireEvent.press(screen.getByTestId('new-appointment-add-contact'));
    expect(screen.getByTestId('new-contact-name').props.value).toBe('');
    expect(screen.getByTestId('new-contact-phone').props.value).toBe('281 555 0111');

    // Mike's number, typed under a new name: Mike is offered instead of a second him.
    await fireEvent.changeText(screen.getByTestId('new-contact-name'), 'Mike J');
    await fireEvent.changeText(screen.getByTestId('new-contact-phone'), '713-555-0142');
    await fireEvent.press(screen.getByTestId('new-contact-save'));
    await waitFor(() =>
      expect(screen.getByTestId('new-contact-already')).toHaveTextContent(
        'Mike Johnson already has this number.',
        { exact: false },
      ),
    );
    expect(change).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('new-contact-choose'));
    expect(screen.getByTestId('new-appointment-for')).toHaveTextContent(
      'For Mike Johnson, at 5107 Evergreen St, Houston, TX 77401',
    );

    // Booked for Mike, who was already here: nothing to wait for.
    await fireEvent.press(screen.getByTestId('ask-for-this-time'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(
        'appointment.create',
        expect.objectContaining({ personId: MIKE_ID }),
        { dependsOn: [] },
      ),
    );
    expect(change).not.toHaveBeenCalledWith('person.create', expect.anything(), expect.anything());
  });

  it('adds them anyway when they share a number with someone else', async () => {
    await sheet();
    await fireEvent.changeText(
      screen.getByTestId('new-appointment-customer-search'),
      'Sara Johnson',
    );
    await fireEvent.press(screen.getByTestId('new-appointment-add-contact'));
    await fireEvent.changeText(screen.getByTestId('new-contact-phone'), '713-555-0142');
    await fireEvent.press(screen.getByTestId('new-contact-save'));
    await waitFor(() => expect(screen.getByTestId('new-contact-already')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('new-contact-anyway'));
    await waitFor(() =>
      expect(screen.getByTestId('new-appointment-for')).toHaveTextContent('For Sara Johnson'),
    );
    expect(change).toHaveBeenCalledWith(
      'person.create',
      expect.objectContaining({
        firstName: 'Sara',
        lastName: 'Johnson',
        phone: '+17135550142',
        ignoreDuplicates: true,
      }),
      expect.anything(),
    );
  });

  it('isn’t offered to someone who may not add customers', async () => {
    await sheet(meWith({ role: 'member', permissions: ['calendar.read'] }));
    await fireEvent.changeText(screen.getByTestId('new-appointment-customer-search'), 'Dana Smith');
    expect(screen.queryByTestId('new-appointment-nobody')).toBeNull();
  });
});
