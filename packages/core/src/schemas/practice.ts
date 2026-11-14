/**
 * Practice businesses (Admin → Try onboarding, 20261027027400): made by HandsFreeOS admins to go through an onboarding
 * as a new customer would, and deleted after.
 */
import { z } from 'zod';
import { displayName, industry, isoDateTime, timezone, uuid } from './common';

export const PracticeStartInput = z.object({
  /** What the practice sign-up's first screen asks for, as `organization.create` takes it. */
  businessName: displayName,
  timezone: timezone.default('America/Chicago'),
  industry: industry.default('home_services'),
});
export type PracticeStartInput = z.input<typeof PracticeStartInput>;
export const PracticeStartOutput = z.object({
  organizationId: uuid,
  workspaceId: uuid,
  /** When the worker deletes it, unless it's ended first. */
  endsAt: isoDateTime,
});

export const PracticeEndInput = z.object({ workspaceId: uuid });
export const PracticeEndOutput = z.object({ workspaceId: uuid, requestedAt: isoDateTime });

export const PracticePayInput = z.object({
  workspaceId: uuid,
  offerId: z.string().trim().min(1).max(64),
  /** The free trial the plan page showed for the plan picked, if any. */
  trialDays: z.number().int().min(0).max(365).nullable().default(null),
});
export const PracticePayOutput = z.object({
  workspaceId: uuid,
  plan: z.enum(['founding_free', 'founding_lifetime', 'monthly']),
});

export const PracticeListInput = z.object({});
export const PracticeListOutput = z.object({
  businesses: z.array(
    z.object({
      organizationId: uuid,
      workspaceId: uuid.nullable(),
      name: z.string(),
      createdAt: isoDateTime,
      endsAt: isoDateTime,
      /** Asked to be deleted, and on its way out. */
      ending: z.boolean(),
    }),
  ),
});
