import { pushSwitchesOf } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import DeskNotifications from '@/app/app/admin/notifications';
import { DeskProvider } from '@/components/admin/staff-context';
import { toast } from '@/components/ui/toast';
import { change } from '@/changes';
import type { RegistrationSnapshot } from '@/push/registration';

import { admin } from './kit';

/**
 * The support desk's own Notifications: somebody who answers support and is in no business has no business's
 * Settings, so New support tickets is here too, saved whole through `user.update_profile` as everywhere else.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/changes', () => ({ change: jest.fn() }));
jest.mock('@/push/hooks', () => ({
  usePushRegistration: (): RegistrationSnapshot =>
    ({ status: 'registered', permission: 'granted', canAskAgain: true }) as RegistrationSnapshot,
}));
jest.mock('@/push/device', () => ({
  pushRegistration: { ask: jest.fn(async () => 'granted'), sync: jest.fn(async () => undefined) },
}));

let settings: Record<string, unknown> = {};

beforeEach(() => {
  jest.clearAllMocks();
  settings = {};
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data: sql.includes('my_profile') ? [{ settings: JSON.stringify(settings) }] : [],
    isLoading: false,
    isFetching: false,
  })) as never);
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

async function show() {
  await render(
    <DeskProvider value={{ userId: admin.userId, staff: admin }}>
      <DeskNotifications />
    </DeskProvider>,
  );
}

it('shows only the support switch, on until turned off, and whether this phone gets them', async () => {
  await show();
  expect(screen.getByTestId('push-supportTickets')).toBeChecked();
  expect(screen.queryByTestId('push-urgent')).toBeNull();
  expect(screen.getByTestId('this-phone-notifications')).toHaveTextContent('On');
});

it('turns New support tickets off, saving every push switch as the other screens do', async () => {
  jest.mocked(change).mockResolvedValue({ id: 'c', queued: false, output: {} } as never);
  await show();
  await fireEvent.press(screen.getByTestId('push-supportTickets'));
  expect(change).toHaveBeenCalledWith('user.update_profile', {
    settings: { push: { ...pushSwitchesOf({}), supportTickets: false } },
  });
  expect(toast.show).toHaveBeenCalledWith('New support tickets: push off');
});

it('puts the switch back and says why when it can’t save', async () => {
  jest.mocked(change).mockRejectedValue(new Error('This needs signal.'));
  await show();
  await fireEvent.press(screen.getByTestId('push-supportTickets'));
  expect(toast.error).toHaveBeenCalledWith('This needs signal.');
  expect(screen.getByTestId('push-supportTickets')).toBeChecked();
});
