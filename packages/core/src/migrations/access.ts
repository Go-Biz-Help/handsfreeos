/**
 * Who may drive a migration (M11, extended 2026-09-18).
 *
 * A migration has two doors, and both lead to the same record. An agency comes in through its organization;
 * a business comes in through itself. Chris's rule is that it should not matter which — "it should look as if
 * they started the migration" — so neither door is read-only and neither is second class.
 *
 * The line that does matter is *how much* each door opens onto. An agency's migration can carry twenty client
 * businesses, and one of those clients must never see, still less change, another's. So a workspace door
 * opens onto that workspace's own part: its sub-account, its counts, its choices, its customers. The database
 * enforces that row by row (0068); this is the same rule stated once for the commands, so a refusal reads as
 * a sentence rather than as a policy violation.
 *
 * Why the commands check by hand instead of declaring a permission: the kernel picks the role to test from
 * the permission's name, so one command can hold either an organization permission or a workspace one, never
 * both. These commands genuinely accept both addresses, so they declare none and ask here.
 */
import { hasOrgPermission, holds } from '../permissions';
import type { OrgRole, WorkspaceRole } from '../permissions';

/** The two ways in. `organization` reaches every business in the migration; `workspace` reaches one. */
export type MigrationDoor = 'organization' | 'workspace';

export interface MigrationReader {
  readonly orgRole: OrgRole | null;
  readonly workspaceRole: WorkspaceRole | null;
  /** What the business lets them do (0106), when the scope knows it. */
  readonly workspacePermissions?: readonly string[] | null;
  readonly workspaceId: string | null;
}

export interface MigrationAccess {
  readonly door: MigrationDoor;
  /** Null when the whole migration is theirs; otherwise the one business they may act for. */
  readonly onlyWorkspaceId: string | null;
}

/**
 * Which door this person came in through, or null when neither is open to them.
 *
 * An agency role flattens into every workspace of its organization (private.effective_workspace_role), so
 * somebody who runs the agency passes the workspace test too. The organization door is checked first so they
 * get the whole migration rather than one business's slice of it.
 */
export function migrationAccess(reader: MigrationReader): MigrationAccess | null {
  if (hasOrgPermission(reader.orgRole, 'org.migrations.manage'))
    return { door: 'organization', onlyWorkspaceId: null };
  if (
    reader.workspaceId &&
    holds(
      { role: reader.workspaceRole, permissions: reader.workspacePermissions },
      'migrations.manage',
    )
  )
    return { door: 'workspace', onlyWorkspaceId: reader.workspaceId };
  return null;
}

/** Whether this reader may act on one particular business's part of a migration. */
export function mayActForWorkspace(access: MigrationAccess, workspaceId: string): boolean {
  return access.onlyWorkspaceId === null || access.onlyWorkspaceId === workspaceId;
}

/**
 * The refusal, in words. Deliberately the same sentence whichever door was tried: telling somebody that a
 * migration exists but is not theirs is an answer they have no use for and a fact they should not have.
 */
export const MIGRATION_NOT_YOURS = 'That migration isn’t there.';

/** What a business may do that an agency may also do, and what only an agency may do. */
export const AGENCY_ONLY_ACTS = [
  // Pointing sub-accounts at businesses across an organization, which is a decision about other people's
  // businesses as much as your own.
  'map several businesses at once',
  // Finishing the whole move, and the checks that span every business in it.
  'finalize the migration',
  // Disconnecting the source, which stops every business still catching up, not only yours.
  'disconnect the source',
] as const;
