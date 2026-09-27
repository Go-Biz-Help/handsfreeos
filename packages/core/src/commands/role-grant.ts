/**
 * Handing someone a role hands them only what whoever hands it out may do here. membership.invite and
 * membership.change_role check the rank (canActOnRole) and then this: the role's permissions in this business, with
 * the business's settings for the role and the person's own (private.role_grant_settings), against the caller's.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import { effectivePermissions, permissionsBeyond, type WorkspaceRole } from '../permissions';

export async function assertMayGrantRole(
  ctx: CommandContext,
  role: WorkspaceRole,
  /** The person it is for, when they are already in the business. */
  userId?: string,
): Promise<void> {
  // Owners hold everything, so there is nothing a role could carry past them.
  if (ctx.scope.workspaceRole === 'owner') return;
  const ws = ctx.scope.workspaceId!;
  const [settings, current] = await Promise.all([
    rows<{ level: 'role' | 'person'; permission: string; allowed: boolean }>(
      ctx.tx,
      sql`select level, permission, allowed
          from private.role_grant_settings(${ws}::uuid, ${role}::app.member_role, ${userId ?? null}::uuid)`,
    ),
    userId
      ? rows<{ permissions: string[] }>(
          ctx.tx,
          sql`select permissions from private.workspace_member_permissions(${ws}::uuid)
              where user_id = ${userId}::uuid`,
        )
      : Promise.resolve([]),
  ]);
  const settingsAt = (level: 'role' | 'person') =>
    Object.fromEntries(
      settings.filter((s) => s.level === level).map((s) => [s.permission, s.allowed]),
    );
  const granted = effectivePermissions(role, settingsAt('role'), settingsAt('person'));
  const beyond = permissionsBeyond(
    { role: ctx.scope.workspaceRole, permissions: ctx.scope.workspacePermissions },
    granted,
    current[0]?.permissions ?? [],
  );
  if (beyond.length > 0)
    throw HfosError.forbidden(
      'That role can do things you can’t here, so only someone who can may give it.',
      'cannot_grant_role',
    );
}
