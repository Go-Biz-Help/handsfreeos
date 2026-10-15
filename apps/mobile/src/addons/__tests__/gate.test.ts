import { holdsAddon } from '../gate';
import { PHONE_ADDONS } from '../registry';

/**
 * The add-on gate (round six): an add-on's permission is in the person's list only while it runs in the business, so
 * holding it answers "is it on here, and may they open it" from the phone's own copy, with no signal.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));

describe('the add-on gate', () => {
  it('lets in whoever holds the permission, and nobody when the list isn’t known', () => {
    expect(holdsAddon({ role: 'member', permissions: ['realestate.use'] }, 'realestate.use')).toBe(
      true,
    );
    expect(holdsAddon({ role: 'owner', permissions: ['customers.read'] }, 'realestate.use')).toBe(
      false,
    );
    // An older copy without a list falls back to the role's defaults, which hold no add-on's permissions.
    expect(holdsAddon({ role: 'owner', permissions: null }, 'realestate.use')).toBe(false);
  });

  it('lists Real Estate Agent, Social Outreach and AI Sales Coach, each behind its use permission', () => {
    expect(PHONE_ADDONS.map((a) => [a.addonId, a.permission])).toEqual([
      ['realestate', 'realestate.use'],
      ['outreach', 'outreach.use'],
      ['salescoach', 'salescoach.use'],
    ]);
  });
});
