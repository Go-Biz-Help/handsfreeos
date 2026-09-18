import { describe, expect, it } from 'vitest';
import { mayActForWorkspace, migrationAccess } from '../src/migrations/index';
import { ROLE_PERMISSIONS } from '../src/permissions';

/**
 * The two doors onto one migration (M11, 2026-09-18). Chris's rule: either an agency or the business itself
 * may start one, and whoever looks afterwards sees the same migration and can act on it. The line that has to
 * hold is how far each door opens — one client of an agency must never reach another's business.
 */
describe('who may drive a migration', () => {
  const agency = { orgRole: 'owner' as const, workspaceRole: null, workspaceId: null };
  const agencyAdmin = { orgRole: 'admin' as const, workspaceRole: null, workspaceId: null };
  const client = { orgRole: null, workspaceRole: 'owner' as const, workspaceId: 'ws-lonestar' };
  const clientAdmin = {
    orgRole: null,
    workspaceRole: 'admin' as const,
    workspaceId: 'ws-lonestar',
  };
  const member = { orgRole: null, workspaceRole: 'member' as const, workspaceId: 'ws-lonestar' };

  it('lets an agency in through the organization, onto the whole migration', () => {
    expect(migrationAccess(agency)).toEqual({ door: 'organization', onlyWorkspaceId: null });
    expect(migrationAccess(agencyAdmin)).toEqual({ door: 'organization', onlyWorkspaceId: null });
  });

  it('lets a business in through itself, onto its own part only', () => {
    expect(migrationAccess(client)).toEqual({
      door: 'workspace',
      onlyWorkspaceId: 'ws-lonestar',
    });
    expect(migrationAccess(clientAdmin)).toEqual({
      door: 'workspace',
      onlyWorkspaceId: 'ws-lonestar',
    });
  });

  it('keeps one client out of another client’s business', () => {
    const access = migrationAccess(client)!;
    expect(mayActForWorkspace(access, 'ws-lonestar')).toBe(true);
    expect(mayActForWorkspace(access, 'ws-bayou')).toBe(false);
  });

  it('lets an agency act for any business in the migration', () => {
    const access = migrationAccess(agency)!;
    expect(mayActForWorkspace(access, 'ws-lonestar')).toBe(true);
    expect(mayActForWorkspace(access, 'ws-bayou')).toBe(true);
  });

  it('does not let a member drive one, in either direction', () => {
    expect(migrationAccess(member)).toBeNull();
    expect(migrationAccess({ orgRole: null, workspaceRole: null, workspaceId: null })).toBeNull();
  });

  it('an agency owner who is also a workspace owner still gets the whole migration', () => {
    // Agency roles flatten into every workspace, so both tests pass for them. The organization door is
    // checked first on purpose, or an agency owner opening one client's page would be narrowed to it.
    const both = {
      orgRole: 'owner' as const,
      workspaceRole: 'owner' as const,
      workspaceId: 'ws-lonestar',
    };
    expect(migrationAccess(both)).toEqual({ door: 'organization', onlyWorkspaceId: null });
  });

  it('gives owners and admins the permission, and members none', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('migrations.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('migrations.manage');
    expect(ROLE_PERMISSIONS.member as readonly string[]).not.toContain('migrations.manage');
  });
});
