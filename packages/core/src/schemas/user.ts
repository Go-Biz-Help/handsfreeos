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

/** Whether the Assistant asks for the person's OK before their next question (assistant/consent.ts). */
export const AssistantConsentState = z.object({
  /** The wording version the Assistant asks for now. */
  version: z.number().int(),
  /** When the person said OK, and to which wording; null until they do. */
  consentedAt: isoDateTime.nullable(),
  consentedVersion: z.number().int().nullable(),
  /** The consent step shows before the next question. */
  needed: z.boolean(),
});

export const MeInput = z.object({});
export const MeOutput = z.object({
  user: Profile,
  organizations: z.array(z.object({ id: uuid, name: z.string(), slug: z.string(), role: orgRole })),
  workspaces: z.array(WorkspaceSummary),
  assistantConsent: AssistantConsentState,
});

/**
 * Delete my account (M10). The person's sign-in and name go, and they're signed out everywhere; what they worked on
 * stays with each business, credited to a former teammate. A business's or agency's only owner hands it over first.
 */
export const AccountDeleteInput = z.object({
  /** The person types their email address to confirm. */
  confirmEmail: z.string().trim().toLowerCase().min(1, 'Type your email address.').max(254),
});
export const AccountDeleteOutput = z.object({
  userId: uuid,
  /** When deletion was asked for; the worker finishes it within moments. */
  requestedAt: isoDateTime,
});

const PersonRef = z.object({ userId: uuid, fullName: z.string(), email: z.string() });

/**
 * Whether Delete my account works now, and what stands in the way (M10). A business that would be left without an
 * owner needs someone else made an owner first (Members); an agency, someone who owns one of its businesses made an
 * owner of the agency (organization.add_owner). An organization holding a single business passes to that business's
 * other owners on its own, and is listed so the page can say so.
 */
export const AccountDeletionCheckInput = z.object({});
export const AccountDeletionCheckOutput = z.object({
  /** Nothing stands in the way. */
  ready: z.boolean(),
  /** Businesses the person is the only owner of. */
  businesses: z.array(
    z.object({
      workspaceId: uuid,
      name: z.string(),
      /** A teammate to suggest making an owner (an admin first, then a member); null when there is nobody else. */
      suggestion: PersonRef.nullable(),
    }),
  ),
  /** Agencies (organizations with several businesses) the person is the only owner of. */
  agencies: z.array(
    z.object({
      organizationId: uuid,
      name: z.string(),
      businessCount: z.number().int(),
      /** Who can be made an owner: people who own one of its businesses (named), or admins of the agency. */
      candidates: z.array(PersonRef.extend({ owns: z.array(z.string()) })),
    }),
  ),
  /** Organizations holding one business that pass to its other owners when the person's account goes. */
  handsOver: z.array(
    z.object({
      organizationId: uuid,
      workspaceId: uuid,
      name: z.string(),
      to: z.array(PersonRef),
    }),
  ),
});

/** The person's OK to send what they ask the Assistant about to an AI service. One OK covers every app. */
export const AssistantConsentInput = z.object({
  /** The wording version they were shown (ASSISTANT_CONSENT_VERSION). */
  version: z.number().int().min(1).max(1000),
});
export const AssistantConsentOutput = z.object({
  version: z.number().int(),
  consentedAt: isoDateTime,
  /** False when they had already said OK to this wording (or a newer one). */
  changed: z.boolean(),
});

// ---------- worker-only (system actor) ----------
/** The account-deletion job, in each business the person was part of. */
export const AccountNoteDeletedInput = z.object({ workspaceId: uuid, userId: uuid });
export const AccountNoteDeletedOutput = z.object({ userId: uuid });
