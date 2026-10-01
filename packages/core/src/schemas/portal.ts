import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/**
 * The client portal's sign-in (Real Estate round two, core): a business lets a customer in, the customer opens a
 * private link and types a code emailed to them on each new device, and that device stays signed in.
 */

const inWorkspace = { workspaceId: uuid };

export const PortalAccessGiveInput = z.object({ ...inWorkspace, personId: uuid });
export const PortalAccessGiveOutput = z.object({
  accessId: uuid,
  /** They were already in: the link went out again. */
  resent: z.boolean(),
  /** Where the link went, masked: "l•••@example.com". */
  sentTo: z.string(),
});

export const PortalAccessRevokeInput = z.object({ ...inWorkspace, personId: uuid });
export const PortalAccessRevokeOutput = z.object({ accessId: uuid, revokedAt: isoDateTime });

export const PortalAccessGetInput = z.object({ ...inWorkspace, personId: uuid });
export const PortalDeviceOut = z.object({
  sessionId: uuid,
  /** What the browser said it was ("Safari on iPhone"), when it said. */
  device: z.string().nullable(),
  signedInAt: isoDateTime,
  lastSeenAt: isoDateTime,
});
export const PortalAccessOut = z.object({
  accessId: uuid,
  /** In, and not turned off. */
  on: z.boolean(),
  givenAt: isoDateTime,
  givenBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  revokedAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  /** The devices signed in now. */
  devices: z.array(PortalDeviceOut),
});
export const PortalAccessGetOutput = z.object({
  /** Their email on file: where a link and a code go. Null means they can't be let in yet. */
  email: z.string().nullable(),
  access: PortalAccessOut.nullable(),
});

// ---------- the worker's, on the customer's behalf ----------

export const PortalSendCodeInput = z.object({ ...inWorkspace, accessId: uuid });
export const PortalSendCodeOutput = z.object({
  codeId: uuid,
  /** Shown once, to the worker that emails it; never kept. */
  code: z.string().regex(/^\d{6}$/),
  to: z.string(),
  sentTo: z.string(),
  business: z.string(),
  firstName: z.string(),
});

export const PortalCheckCodeInput = z.object({
  ...inWorkspace,
  accessId: uuid,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Type the 6 digits from the email.'),
  /** sha256 of the bearer the worker made for this device, hex; the bearer itself never leaves the worker. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  device: z.string().trim().max(200).nullable().default(null),
});
export const PortalCheckCodeOutput = z.object({
  verified: z.boolean(),
  triesLeft: z.number().int().min(0),
  sessionId: uuid.nullable(),
  expiresAt: isoDateTime.nullable(),
});

export const PortalSessionEndInput = z.object({ ...inWorkspace, sessionId: uuid });
export const PortalSessionEndOutput = z.object({ ended: z.boolean() });

export const PortalSessionSeenInput = z.object({ ...inWorkspace, sessionId: uuid });
export const PortalSessionSeenOutput = z.object({ lastSeenAt: isoDateTime });

// ---------- the customer's own, in their portal ----------

export const PortalHomeInput = z.object({ ...inWorkspace });
export const PortalHomePage = z.object({
  /** Relative to the add-on's portal pages: '' for its first. */
  path: z.string(),
  title: z.string(),
});
export const PortalHomeOutput = z.object({
  business: z.object({ name: z.string() }),
  person: z.object({ firstName: z.string(), lastName: z.string() }),
  /** The add-ons with pages for them: on in the business, and with records they're on. */
  addons: z.array(z.object({ id: z.string(), name: z.string(), pages: z.array(PortalHomePage) })),
});
