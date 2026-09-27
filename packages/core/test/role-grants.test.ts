/**
 * Handing someone a role hands them only what whoever hands it out may do (membership.invite and
 * membership.change_role). The rank alone let an admin the business had kept from money invite a second address of
 * their own as an admin, with the role's full set.
 */
import { describe, expect, it } from 'vitest';
import { effectivePermissions, permissionsBeyond } from '../src';

const admin = effectivePermissions('admin');
const keptFromMoney = effectivePermissions('admin', {}, { 'money.manage': false });

describe('what a role handed out may carry', () => {
  it('lets an admin with the role’s defaults hand out admin and member', () => {
    expect(permissionsBeyond({ role: 'admin', permissions: admin }, admin)).toEqual([]);
    expect(
      permissionsBeyond({ role: 'admin', permissions: admin }, effectivePermissions('member')),
    ).toEqual([]);
  });

  it('refuses an admin the business kept from something the role still has', () => {
    expect(permissionsBeyond({ role: 'admin', permissions: keptFromMoney }, admin)).toEqual([
      'money.manage',
    ]);
  });

  it('follows the business’s setting for the role being handed out', () => {
    const adminsWithoutMoney = effectivePermissions('admin', { 'money.manage': false });
    expect(
      permissionsBeyond({ role: 'admin', permissions: keptFromMoney }, adminsWithoutMoney),
    ).toEqual([]);
  });

  it('never counts what the person already holds, so moving someone down is not handing anything out', () => {
    expect(
      permissionsBeyond(
        { role: 'admin', permissions: keptFromMoney },
        effectivePermissions('member'),
        admin,
      ),
    ).toEqual([]);
  });
});
