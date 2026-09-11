/**
 * Fixed roles and permissions for Milestone 1. `app.role_permissions` in the database is the
 * enforcement copy (used by RLS); test/permissions-parity.test.ts asserts both stay identical.
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ORG_ROLES = ['owner', 'admin'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_PERMISSIONS = {
  owner: [
    'workspace.read',
    'workspace.update',
    'workspace.delete',
    'members.read',
    'members.invite',
    'members.change_role',
    'members.remove',
    'invitations.read',
    'invitations.revoke',
    'audit.read',
  ],
  admin: [
    'workspace.read',
    'workspace.update',
    'members.read',
    'members.invite',
    'members.change_role',
    'members.remove',
    'invitations.read',
    'invitations.revoke',
    'audit.read',
  ],
  member: ['workspace.read', 'members.read'],
  org_owner: [
    'org.read',
    'org.update',
    'org.delete',
    'org.members.manage',
    'workspace.create',
    'org.audit.read',
  ],
  org_admin: ['org.read', 'workspace.create', 'org.audit.read'],
} as const satisfies Record<string, readonly string[]>;

export type RoleKey = keyof typeof ROLE_PERMISSIONS;
export type Permission = (typeof ROLE_PERMISSIONS)[RoleKey][number];

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: 'Full control, including deleting the workspace and managing other Owners.',
  admin: 'Manages people and settings. Cannot change or remove Owners.',
  member: 'Works in the workspace. Cannot invite or manage people.',
};

/** member 1 < admin 2 < owner 3; anything else 0. */
export function roleRank(role: string | null | undefined): number {
  switch (role) {
    case 'owner':
      return 3;
    case 'admin':
      return 2;
    case 'member':
      return 1;
    default:
      return 0;
  }
}

/** You may grant, change to, or act on a role only at or below your own rank. */
export function canActOnRole(actorRole: WorkspaceRole | null, targetRole: WorkspaceRole): boolean {
  return roleRank(actorRole) > 0 && roleRank(targetRole) <= roleRank(actorRole);
}

export function isOrgPermission(permission: Permission): boolean {
  return permission.startsWith('org.') || permission === 'workspace.create';
}

export function hasWorkspacePermission(
  role: WorkspaceRole | null,
  permission: Permission,
): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

export function hasOrgPermission(role: OrgRole | null, permission: Permission): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[`org_${role}`] as readonly string[]).includes(permission);
}

/** Highest of a direct workspace role and the org role's implied workspace role. */
export function effectiveWorkspaceRole(
  direct: WorkspaceRole | null,
  orgRole: OrgRole | null,
): WorkspaceRole | null {
  const candidates: WorkspaceRole[] = [];
  if (direct) candidates.push(direct);
  if (orgRole) candidates.push(orgRole);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => roleRank(b) - roleRank(a))[0] ?? null;
}
