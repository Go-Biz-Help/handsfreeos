/**
 * Handing someone a role hands them only what whoever hands it out may do here. membership.invite and
 * membership.change_role check the rank (canActOnRole) and then this: what the role would carry in this business —
 * the business's settings for the role and the person's own, and the permissions of the add-ons that run here — as
 * the database works it out (private.role_would_grant, the same rules as everyone's own list), against the caller's.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import { permissionsBeyond, type WorkspaceRole } from '../permissions';

export async function assertMayGrantRole(
  ctx: CommandContext,
  role: WorkspaceRole,
  /** The person it is for, when they are already in the business. */
  userId?: string,
): Promise<void> {
  // Owners hold everything, so there is nothing a role could carry past them.
  if (ctx.scope.workspaceRole === 'owner') return;
  const ws = ctx.scope.workspaceId!;
  const [grants, current] = await Promise.all([
    rows<{ permissions: string[] }>(
      ctx.tx,
      sql`select private.role_would_grant(${ws}::uuid, ${role}::app.member_role, ${userId ?? null}::uuid)
            as permissions`,
    ),
    userId
      ? rows<{ permissions: string[] }>(
          ctx.tx,
          sql`select permissions from private.workspace_member_permissions(${ws}::uuid)
              where user_id = ${userId}::uuid`,
        )
      : Promise.resolve([]),
  ]);
  const granted = grants[0]?.permissions ?? [];
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
