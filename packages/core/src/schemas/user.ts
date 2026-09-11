import { z } from 'zod';
import { displayName, isoDateTime, orgRole, settings, uuid } from './common';
import { WorkspaceSummary } from './workspace';

export const UserUpdateProfileInput = z
  .object({
    fullName: displayName.optional(),
    avatarUrl: z.url().max(2048).nullable().optional(),
    settings: settings.optional(),
  })
  .refine(
    (v) => v.fullName !== undefined || v.avatarUrl !== undefined || v.settings !== undefined,
    {
      error: 'Nothing to update.',
    },
  );
export const UserUpdateProfileOutput = z.object({ userId: uuid, updated: z.array(z.string()) });

export const Profile = z.object({
  id: uuid,
  email: z.string(),
  fullName: z.string(),
  avatarUrl: z.string().nullable(),
  settings: settings,
  createdAt: isoDateTime,
});

export const MeInput = z.object({});
export const MeOutput = z.object({
  user: Profile,
  organizations: z.array(z.object({ id: uuid, name: z.string(), slug: z.string(), role: orgRole })),
  workspaces: z.array(WorkspaceSummary),
});
