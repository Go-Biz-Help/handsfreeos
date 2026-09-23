import { holds } from '@hfos/core';

import { permissionsOf } from '../grants';

jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));

/**
 * What a person may do, as the phone reads it from its copy (0106): the synced `text[]` arrives as a JSON array,
 * and anything the phone can't read counts as "not known yet", so their role's defaults stand in.
 */
describe('what the phone knows a person may do', () => {
  it('reads the synced list', () => {
    expect(permissionsOf('["money.read","money.bill"]')).toEqual(['money.read', 'money.bill']);
    expect(permissionsOf('[]')).toEqual([]);
  });

  it('knows nothing from an older copy, or from something it can’t read', () => {
    expect(permissionsOf(null)).toBeNull();
    expect(permissionsOf('')).toBeNull();
    expect(permissionsOf('{money.read}')).toBeNull();
    expect(permissionsOf('"money.read"')).toBeNull();
  });

  it('goes by the list when there is one, and by the role when there isn’t', () => {
    const bills = permissionsOf('["money.read","money.bill"]');
    expect(holds({ role: 'member', permissions: bills }, 'money.bill')).toBe(true);
    expect(holds({ role: 'member', permissions: null }, 'money.bill')).toBe(false);
    // An admin the business kept from money: the list wins over the role.
    expect(holds({ role: 'admin', permissions: ['records.read'] }, 'money.manage')).toBe(false);
  });
});
