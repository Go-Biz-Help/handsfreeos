import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import NotificationSettings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/notifications';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change, ChangeError, NEEDS_SIGNAL } from '@/changes';
import type { Me } from '@/lib/businesses';
import type { RegistrationSnapshot } from '@/push/registration';
import type { Staff } from '@/admin/staff';

/**
 * Settings → Notifications: the push switches beside email, saved whole through `user.update_profile` as the web saves
 * them, online only ("This needs signal."), with a refusal putting the switch back; New support tickets only for
 * someone who answers HandsFreeOS support; this phone's own permission, with the way to its settings; and
 * "On N phones".
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  // The top bar's mark reads the screen it's on, so the question carries the record (M10 step 17).
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return { change: jest.fn(), ChangeError: actual.ChangeError, NEEDS_SIGNAL: actual.NEEDS_SIGNAL };
});

let mockStaff: Staff | null = null;
jest.mock('@/admin/staff', () => ({
  useStaff: () => ({ staff: mockStaff, status: 'ready', error: null, reload: () => undefined }),
}));

let mockRegistration: RegistrationSnapshot;
jest.mock('@/push/hooks', () => ({ usePushRegistration: () => mockRegistration }));
jest.mock('@/push/device', () => ({
  pushRegistration: { ask: jest.fn(async () => 'granted'), sync: jest.fn(async () => undefined) },
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
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

let settings: Record<string, unknown> = {};
let phones = 2;

function mockQueries() {
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data: sql.includes('my_profile')
      ? [{ settings: JSON.stringify(settings) }]
      : sql.includes('push_devices')
        ? [{ n: phones }]
        : [],
    isLoading: false,
    isFetching: false,
  })) as never);
}

async function show() {
  mockQueries();
  await render(
    <BusinessProvider
      value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
    >
      <NotificationSettings />
    </BusinessProvider>,
  );
}

const ALL_ON = {
  customerWaiting: true,
  missedCall: true,
  urgent: true,
  approval: true,
  booking: true,
  assigned: true,
  payment: false,
  wallet: true,
  jobs: true,
  connections: true,
  addons: true,
  supportTickets: true,
  qualifying: true,
};

beforeEach(() => {
  settings = {};
  phones = 2;
  mockStaff = null;
  mockRegistration = {
    status: 'registered',
    permission: 'granted',
    canAskAgain: true,
    token: 'ExponentPushToken[e2e-1]',
    registeredAt: 1,
    message: null,
  };
  jest.mocked(change).mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('Settings → Notifications', () => {
  it('shows a push switch for each moment beside email, payments off until turned on, and the person’s phones', async () => {
    await show();
    for (const key of ['customerWaiting', 'urgent', 'approval', 'booking', 'assigned'])
      expect(screen.getByTestId(`push-${key}`)).toBeChecked();
    expect(screen.getByTestId('push-payment')).not.toBeChecked();
    expect(screen.getByTestId('email-unansweredEmail')).toBeChecked();
    // Approvals' email, and the AI teammate's qualifying.
    expect(screen.getAllByText('Always')).toHaveLength(2);
    expect(screen.getByText('Morning summary')).toBeTruthy();
    // Dale owns a business on its own, not an agency: no agency digest. Nor does he answer support.
    expect(screen.queryByText('Daily agency digest')).toBeNull();
    expect(screen.queryByTestId('push-supportTickets')).toBeNull();
    expect(screen.getByText('On 2 phones')).toBeTruthy();
    expect(screen.getByTestId('this-phone-notifications')).toHaveTextContent('On');
  });

  it('follows what the web saved, as the person’s profile syncs', async () => {
    settings = {
      push: { ...ALL_ON, urgent: false, payment: true },
      notifications: { bookingEmail: false },
    };
    phones = 1;
    await show();
    expect(screen.getByTestId('push-urgent')).not.toBeChecked();
    expect(screen.getByTestId('push-payment')).toBeChecked();
    expect(screen.getByTestId('email-bookingEmail')).not.toBeChecked();
    expect(screen.getByText('On 1 phone')).toBeTruthy();
  });

  it('saves every push switch through user.update_profile, and says so', async () => {
    jest.mocked(change).mockResolvedValue({ id: 'c', queued: false, output: {} } as never);
    await show();
    await fireEvent.press(screen.getByTestId('push-urgent'));
    expect(change).toHaveBeenCalledWith('user.update_profile', {
      settings: { push: { ...ALL_ON, urgent: false } },
    });
    expect(toast.show).toHaveBeenCalledWith('Urgent items: push off');
    expect(screen.getByTestId('push-urgent')).not.toBeChecked();
  });

  it('saves all seven email switches when an email switch changes', async () => {
    jest.mocked(change).mockResolvedValue({ id: 'c', queued: false, output: {} } as never);
    await show();
    await fireEvent.press(screen.getByTestId('email-attentionDigest'));
    expect(change).toHaveBeenCalledWith('user.update_profile', {
      settings: {
        notifications: {
          unansweredEmail: true,
          attentionDigest: false,
          aiHandoff: true,
          bookingEmail: true,
          paymentEmail: true,
          agencyDigest: true,
          eveningSummary: true,
          addonEmail: true,
        },
      },
    });
    expect(toast.show).toHaveBeenCalledWith('Morning summary: email off');
  });

  it('needs signal: says so and puts the switch back', async () => {
    jest.mocked(change).mockRejectedValue(new ChangeError('needs-signal', NEEDS_SIGNAL));
    await show();
    await fireEvent.press(screen.getByTestId('push-payment'));
    await act(async () => undefined);
    expect(toast.error).toHaveBeenCalledWith('This needs signal.');
    expect(screen.getByTestId('push-payment')).not.toBeChecked();
  });

  it('shows a refusal in HandsFreeOS’s own words and puts the switch back', async () => {
    jest
      .mocked(change)
      .mockRejectedValue(
        new ChangeError(
          'too-old',
          'This version of HandsFreeOS is too old. Update it to keep going.',
        ),
      );
    await show();
    await fireEvent.press(screen.getByTestId('push-booking'));
    await act(async () => undefined);
    expect(toast.error).toHaveBeenCalledWith(
      'This version of HandsFreeOS is too old. Update it to keep going.',
    );
    expect(screen.getByTestId('push-booking')).toBeChecked();
  });

  it('shows New support tickets to someone who answers HandsFreeOS support, on until turned off', async () => {
    mockStaff = {
      userId: DALE,
      role: 'agent',
      displayName: 'Dale',
      permissions: ['support.read', 'support.reply'],
      founder: false,
    };
    jest.mocked(change).mockResolvedValue({ id: 'c', queued: false, output: {} } as never);
    await show();
    expect(screen.getByText('New support tickets')).toBeTruthy();
    expect(screen.getByTestId('push-supportTickets')).toBeChecked();
    await fireEvent.press(screen.getByTestId('push-supportTickets'));
    expect(change).toHaveBeenCalledWith('user.update_profile', {
      settings: { push: { ...ALL_ON, supportTickets: false } },
    });
    expect(toast.show).toHaveBeenCalledWith('New support tickets: push off');
  });

  it('shows the agency digest to an owner of an agency', async () => {
    const agency: Me = {
      ...me,
      businesses: [
        me.businesses[0]!,
        { ...me.businesses[0]!, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      ],
    };
    mockQueries();
    await render(
      <BusinessProvider
        value={{
          userId: DALE,
          me: agency,
          business: agency.businesses[0]!,
          openSwitcher: () => undefined,
        }}
      >
        <NotificationSettings />
      </BusinessProvider>,
    );
    expect(screen.getByText('Daily agency digest')).toBeTruthy();
  });
});

describe('this phone', () => {
  it('opens the phone’s settings when notifications are turned off there', async () => {
    mockRegistration = {
      ...mockRegistration,
      status: 'no-permission',
      permission: 'denied',
      canAskAgain: false,
    };
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await show();
    expect(screen.getByTestId('this-phone-notifications')).toHaveTextContent('Off');
    await fireEvent.press(screen.getByTestId('open-phone-settings'));
    expect(open).toHaveBeenCalled();
  });

  it('offers to turn notifications on when the phone hasn’t been asked', async () => {
    mockRegistration = {
      ...mockRegistration,
      status: 'no-permission',
      permission: 'undetermined',
      canAskAgain: true,
    };
    await show();
    expect(screen.getByTestId('this-phone-notifications')).toHaveTextContent('Not turned on');
    expect(screen.getByTestId('turn-on-notifications')).toBeTruthy();
  });

  it('says plainly when this build can’t get notifications', async () => {
    mockRegistration = { ...mockRegistration, status: 'no-project', token: null };
    await show();
    expect(screen.getByTestId('this-phone-notifications')).toHaveTextContent('Not in this build');
    expect(
      screen.getByText(
        'This build of the app isn’t set up for notifications, so this phone gets none.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('turn-on-notifications')).toBeNull();
  });
});
