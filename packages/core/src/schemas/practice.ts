/**
 * Practice businesses (Admin → Try onboarding, 20261027027400): made by HandsFreeOS admins to go through an onboarding
 * as a new customer would, and deleted after.
 */
import { z } from 'zod';
import { displayName, industry, isoDateTime, timezone, uuid } from './common';

/**
 * Whose a practice business is (20261027027500): `owner`, yours as a new customer's is; `agency`, a client's of an
 * agency you own, which you aren't on the team of and hand to its owner at the end of its setup; `invited`, nobody's
 * yet, with you invited to join it at `role`.
 */
export const PRACTICE_AS = ['owner', 'agency', 'invited'] as const;
export type PracticeAs = (typeof PRACTICE_AS)[number];

export const PracticeStartInput = z.object({
  /** What the practice sign-up's first screen asks for, as `organization.create` takes it. */
  businessName: displayName,
  timezone: timezone.default('America/Chicago'),
  industry: industry.default('home_services'),
  as: z.enum(PRACTICE_AS).default('owner'),
  /** The agency's name, for `agency`: the organization the client's business is under. */
  agencyName: displayName.optional(),
  /** The role you're invited at, for `invited`. An owner joins through an agency's handover instead. */
  role: z.enum(['admin', 'member']).default('member'),
  /** Its plan already "paid", for an onboarding that starts in a business that's ready (an add-on's setup). */
  ready: z.boolean().default(false),
});
export type PracticeStartInput = z.input<typeof PracticeStartInput>;
export const PracticeStartOutput = z.object({
  organizationId: uuid,
  workspaceId: uuid,
  /** When the worker deletes it, unless it's ended first. */
  endsAt: isoDateTime,
  /** For `invited`: the invitation the worker is emailing you. */
  invitationId: uuid.nullable(),
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
      /** You're in it. Not yet when it's one you were invited to join and haven't. */
      joined: z.boolean(),
      /** An invitation into it is waiting. */
      invited: z.boolean(),
    }),
  ),
});
