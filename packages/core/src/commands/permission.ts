/**
 * What an owner sets about what people may do in their business (0103): one permission on or off for the Admin
 * or Member role, or for one person, or every setting for a role or a person back to what the level above says.
 *
 * The database works out what everyone may do from these (private.user_permissions) and keeps the answer where
 * every rule reads it, so nothing here has to repaint anything: a person's own setting wins, then their role's,
 * then the default, and a permission whose requirements are off is off. Owners always keep everything, so there is
 * no setting for them to lose.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { memberPermissionOverrides, rolePermissionOverrides } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  CUSTOMIZABLE_PERMISSIONS,
  effectivePermissions,
  ROLE_LABELS,
  type CustomizableRole,
} from '../permissions';
import {
  PermissionResetInput,
  PermissionSetMemberInput,
  PermissionSetRoleInput,
  PermissionStateOutput,
} from '../schemas/permission';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** "Send estimates and invoices, start plans", for the audit log. */
const labelOf = (permission: string): string =>
  CUSTOMIZABLE_PERMISSIONS.find((p) => p.permission === permission)?.label ?? permission;

const said = (allowed: boolean | null | undefined): string =>
  allowed === true ? 'on' : allowed === false ? 'off' : 'as the default';

/** One role's own settings here, by permission. */
async function roleSettings(ctx: CommandContext, role: CustomizableRole) {
  const list = await ctx.tx
    .select({
      permission: rolePermissionOverrides.permission,
      allowed: rolePermissionOverrides.allowed,
    })
    .from(rolePermissionOverrides)
    .where(
      and(
        eq(rolePermissionOverrides.workspaceId, ctx.scope.workspaceId!),
        eq(rolePermissionOverrides.role, role),
      ),
    );
  return Object.fromEntries(list.map((r) => [r.permission, r.allowed]));
}

/** What one person may do here now, as the database keeps it. */
async function effectiveFor(ctx: CommandContext, userId: string): Promise<string[]> {
  const [row] = await rows<{ permissions: string[] }>(
    ctx.tx,
    sql`select private.user_permissions(${userId}::uuid, ${ctx.scope.workspaceId!}::uuid) as permissions`,
  );
  return row?.permissions ?? [];
}

/** Somebody in the business who isn't an owner: owners always keep everything. */
async function requireSettablePerson(ctx: CommandContext, userId: string) {
  const [row] = await rows<{ role: string | null; name: string | null }>(
    ctx.tx,
    sql`select private.user_workspace_role(${userId}::uuid, ${ctx.scope.workspaceId!}::uuid) as role,
          (select coalesce(nullif(u.full_name, ''), u.email::text) from app.users u where u.id = ${userId}::uuid)
            as name`,
  );
  if (!row?.role)
    throw HfosError.validation([{ path: 'userId', message: 'Pick someone in this business.' }]);
  if (row.role === 'owner')
    throw HfosError.rule(
      'permission_owner',
      409,
      'Owners can always do everything. Change their role first to set what they may do.',
    );
  return { role: row.role, name: row.name ?? 'Someone' };
}

export const permissionSetRole = defineCommand({
  name: 'permission.set_role',
  description:
    'Turn one permission on or off for everyone with the Admin or Member role in this business, or (allowed null) back to the default. A person’s own setting still wins. Owners only.',
  risk: 3,
  input: PermissionSetRoleInput,
  output: PermissionStateOutput,
  permission: 'permissions.manage',
  scope: inWorkspace,
  emits: ['permission.role_set'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const role = input.role as CustomizableRole;
    const before = await roleSettings(ctx, role);
    const was = before[input.permission];
    if ((was ?? null) === input.allowed)
      return { changed: false, effective: effectivePermissions(role, before) };
    if (input.allowed === null)
      await ctx.tx
        .delete(rolePermissionOverrides)
        .where(
          and(
            eq(rolePermissionOverrides.workspaceId, ws),
            eq(rolePermissionOverrides.role, role),
            eq(rolePermissionOverrides.permission, input.permission),
          ),
        );
    else
      await ctx.tx
        .insert(rolePermissionOverrides)
        .values({
          workspaceId: ws,
          role,
          permission: input.permission,
          allowed: input.allowed,
          updatedBy: me,
        })
        .onConflictDoUpdate({
          target: [
            rolePermissionOverrides.workspaceId,
            rolePermissionOverrides.role,
            rolePermissionOverrides.permission,
          ],
          set: { allowed: input.allowed, updatedBy: me, updatedAt: new Date() },
        });
    const after = { ...before };
    if (input.allowed === null) delete after[input.permission];
    else after[input.permission] = input.allowed;
    await ctx.emit({
      type: 'permission.role_set',
      entityType: 'workspace',
      entityId: ws,
      payload: { role, permission: input.permission, allowed: input.allowed },
      before: { role: ROLE_LABELS[role], [labelOf(input.permission)]: said(was) },
      after: { role: ROLE_LABELS[role], [labelOf(input.permission)]: said(input.allowed) },
    });
    return { changed: true, effective: effectivePermissions(role, after) };
  },
});

export const permissionSetMember = defineCommand({
  name: 'permission.set_member',
  description:
    'Turn one permission on or off for one person in this business, whatever their role says, or (allowed null) back to what their role says. Not for owners. Owners only.',
  risk: 3,
  input: PermissionSetMemberInput,
  output: PermissionStateOutput,
  permission: 'permissions.manage',
  scope: inWorkspace,
  emits: ['permission.member_set'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const person = await requireSettablePerson(ctx, input.userId);
    const [now] = await ctx.tx
      .select({ allowed: memberPermissionOverrides.allowed })
      .from(memberPermissionOverrides)
      .where(
        and(
          eq(memberPermissionOverrides.workspaceId, ws),
          eq(memberPermissionOverrides.userId, input.userId),
          eq(memberPermissionOverrides.permission, input.permission),
        ),
      );
    const was = now?.allowed ?? null;
    if (was === input.allowed)
      return { changed: false, effective: await effectiveFor(ctx, input.userId) };
    if (input.allowed === null)
      await ctx.tx
        .delete(memberPermissionOverrides)
        .where(
          and(
            eq(memberPermissionOverrides.workspaceId, ws),
            eq(memberPermissionOverrides.userId, input.userId),
            eq(memberPermissionOverrides.permission, input.permission),
          ),
        );
    else
      await ctx.tx
        .insert(memberPermissionOverrides)
        .values({
          workspaceId: ws,
          userId: input.userId,
          permission: input.permission,
          allowed: input.allowed,
          updatedBy: me,
        })
        .onConflictDoUpdate({
          target: [
            memberPermissionOverrides.workspaceId,
            memberPermissionOverrides.userId,
            memberPermissionOverrides.permission,
          ],
          set: { allowed: input.allowed, updatedBy: me, updatedAt: new Date() },
        });
    await ctx.emit({
      type: 'permission.member_set',
      entityType: 'workspace_membership',
      entityId: input.userId,
      payload: { userId: input.userId, permission: input.permission, allowed: input.allowed },
      before: { person: person.name, [labelOf(input.permission)]: said(was) },
      after: {
        person: person.name,
        [labelOf(input.permission)]: input.allowed === null ? 'as their role' : said(input.allowed),
      },
    });
    return { changed: true, effective: await effectiveFor(ctx, input.userId) };
  },
});

export const permissionReset = defineCommand({
  name: 'permission.reset',
  description:
    'Put every permission for the Admin or Member role back to the default, or every permission for one person back to what their role says. Owners only.',
  risk: 3,
  input: PermissionResetInput,
  output: PermissionStateOutput,
  permission: 'permissions.manage',
  scope: inWorkspace,
  emits: ['permission.reset'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    if (input.role) {
      const role = input.role as CustomizableRole;
      const gone = await ctx.tx
        .delete(rolePermissionOverrides)
        .where(
          and(eq(rolePermissionOverrides.workspaceId, ws), eq(rolePermissionOverrides.role, role)),
        )
        .returning({ permission: rolePermissionOverrides.permission });
      if (gone.length)
        await ctx.emit({
          type: 'permission.reset',
          entityType: 'workspace',
          entityId: ws,
          payload: { role, permissions: gone.map((g) => g.permission) },
          after: { role: ROLE_LABELS[role], permissions: 'back to the default' },
        });
      return { changed: gone.length > 0, effective: effectivePermissions(role) };
    }
    const person = await requireSettablePerson(ctx, input.userId!);
    const gone = await ctx.tx
      .delete(memberPermissionOverrides)
      .where(
        and(
          eq(memberPermissionOverrides.workspaceId, ws),
          eq(memberPermissionOverrides.userId, input.userId!),
        ),
      )
      .returning({ permission: memberPermissionOverrides.permission });
    if (gone.length)
      await ctx.emit({
        type: 'permission.reset',
        entityType: 'workspace_membership',
        entityId: input.userId!,
        payload: { userId: input.userId, permissions: gone.map((g) => g.permission) },
        after: { person: person.name, permissions: 'as their role' },
      });
    return { changed: gone.length > 0, effective: await effectiveFor(ctx, input.userId!) };
  },
});

export const permissionCommands = [permissionSetRole, permissionSetMember, permissionReset];
