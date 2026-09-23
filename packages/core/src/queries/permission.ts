/**
 * The permissions settings page (0105): what each customizable role may do in this business with the business's own
 * settings for it, and each person's — their role, their own settings, and what they may do in the end.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { memberPermissionOverrides, rolePermissionOverrides } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { CUSTOMIZABLE_ROLES, effectivePermissions, type WorkspaceRole } from '../permissions';
import { PermissionSettingsInput, PermissionSettingsOutput } from '../schemas/permission';

export const permissionSettings = defineQuery({
  name: 'permission.settings',
  description:
    'What the Admin and Member roles may do in this business, with the business’s own settings for them, and what each person may do, with theirs. Owners only.',
  input: PermissionSettingsInput,
  output: PermissionSettingsOutput,
  permission: 'permissions.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [roleRows, memberRows, people] = await Promise.all([
      ctx.tx
        .select()
        .from(rolePermissionOverrides)
        .where(eq(rolePermissionOverrides.workspaceId, ws)),
      ctx.tx
        .select()
        .from(memberPermissionOverrides)
        .where(eq(memberPermissionOverrides.workspaceId, ws)),
      rows<{
        user_id: string;
        role: WorkspaceRole;
        permissions: string[];
        full_name: string;
        email: string;
      }>(
        ctx.tx,
        sql`select m.user_id, m.role, m.permissions, coalesce(nullif(u.full_name, ''), u.email::text) as full_name,
              u.email::text as email
            from private.workspace_member_permissions(${ws}::uuid) m
            join app.users u on u.id = m.user_id
            order by private.role_rank(m.role) desc, lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
      ),
    ]);
    const settingsOf = (list: readonly { permission: string; allowed: boolean }[]) =>
      Object.fromEntries(list.map((r) => [r.permission, r.allowed]));
    return {
      roles: CUSTOMIZABLE_ROLES.map((role) => {
        const settings = settingsOf(roleRows.filter((r) => r.role === role));
        return { role, settings, effective: effectivePermissions(role, settings) };
      }),
      people: people.map((p) => ({
        userId: p.user_id,
        fullName: p.full_name,
        email: p.email,
        role: p.role,
        settings:
          p.role === 'owner' ? {} : settingsOf(memberRows.filter((r) => r.userId === p.user_id)),
        effective: p.permissions,
      })),
    };
  },
});
