/**
 * What an owner sets about what people may do (0105): a role's permissions in their business, one person's, and
 * the settings page that shows both.
 */
import { z } from 'zod';
import { CUSTOMIZABLE_PERMISSIONS, CUSTOMIZABLE_ROLES } from '../permissions';
import { uuid, workspaceRole } from './common';

export const customizableRole = z.enum(CUSTOMIZABLE_ROLES);

export const customizablePermission = z.enum(
  CUSTOMIZABLE_PERMISSIONS.map((p) => p.permission) as [string, ...string[]],
);

/** On, off, or null to go back to what the level above says (the role's setting, or the default). */
const allowed = z.boolean().nullable();

export const PermissionSetRoleInput = z.object({
  workspaceId: uuid,
  role: customizableRole,
  permission: customizablePermission,
  allowed,
});

export const PermissionSetMemberInput = z.object({
  workspaceId: uuid,
  userId: uuid,
  permission: customizablePermission,
  allowed,
});

/** Every setting for one role, or for one person, back to what the level above says. */
export const PermissionResetInput = z
  .object({
    workspaceId: uuid,
    role: customizableRole.optional(),
    userId: uuid.optional(),
  })
  .refine((i) => (i.role === undefined) !== (i.userId === undefined), {
    path: ['role'],
    error: 'Name a role or a person.',
  });

export const PermissionStateOutput = z.object({
  changed: z.boolean(),
  /** What the role, or the person, may do now. */
  effective: z.array(z.string()),
});

/** One level's own answers: the permissions it turns on (true) or off (false). */
const settings = z.record(z.string(), z.boolean());

export const PermissionSettingsInput = z.object({ workspaceId: uuid });
export const PermissionSettingsOutput = z.object({
  roles: z.array(
    z.object({
      role: customizableRole,
      settings,
      /** What someone with the role and no settings of their own may do. */
      effective: z.array(z.string()),
    }),
  ),
  people: z.array(
    z.object({
      userId: uuid,
      fullName: z.string(),
      email: z.string(),
      role: workspaceRole,
      settings,
      effective: z.array(z.string()),
    }),
  ),
});
