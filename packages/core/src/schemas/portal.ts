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
  /** Whether they're a partner of the business, while partners are on in it: their page is `portal.partner`. */
  partner: z.boolean(),
  /** The documents they sign or get a copy of (not voided ones), and how many are theirs to sign now. */
  documents: z.object({ total: z.int(), toSign: z.int() }),
});

// ---------- documents to sign in the portal (answer 10b) ----------

export const PortalDocumentsInput = z.object({ ...inWorkspace });
export const PortalDocumentOut = z.object({
  /** Their own place on it: what opening it from the portal names. */
  signerId: uuid,
  documentId: uuid,
  name: z.string(),
  /** signer: they sign it. copy: they get the signed copy. */
  kind: z.enum(['signer', 'copy']),
  status: z.enum(['out', 'completed', 'declined', 'expired']),
  signerStatus: z.enum(['waiting', 'sent', 'opened', 'signed', 'declined']),
  /** It's theirs to sign now. */
  yourTurn: z.boolean(),
  sentAt: isoDateTime,
  expiresAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  signedCopy: z.boolean(),
});
export const PortalDocumentsOutput = z.object({ documents: z.array(PortalDocumentOut) });

// ---------- files in the portal ----------

/** What a customer may add from their portal: PDFs and photos, 20 MB each, 30 a day (Chris, round two). */
export const PORTAL_UPLOAD_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
] as const;
export const PORTAL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const PORTAL_UPLOADS_PER_DAY = 30;

export const PortalUploadBeginInput = z.object({
  ...inWorkspace,
  /** One of the records they're on (a deal); absent, it goes on them. */
  recordId: uuid.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().max(100),
  sizeBytes: z.number().int().min(1),
});
export const PortalUploadBeginOutput = z.object({
  fileId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});

export const PortalUploadConfirmInput = z.object({ ...inWorkspace, fileId: uuid });
export const PortalUploadConfirmOutput = z.object({
  fileId: uuid,
  /** False when what arrived isn't allowed after all (too big, or not a PDF or photo): it was removed. */
  accepted: z.boolean(),
  refusal: z.object({ rule: z.string(), message: z.string() }).nullable(),
  name: z.string(),
  sizeBytes: z.number().int(),
  mimeType: z.string(),
});

export const PortalFilesInput = z.object({
  ...inWorkspace,
  recordId: uuid.nullable().default(null),
});
export const PortalFileOut = z.object({
  id: uuid,
  name: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  /** The record it's on; null when it's on them. */
  recordId: uuid.nullable(),
  /** They added it. */
  fromYou: z.boolean(),
  locked: z.boolean(),
  addedAt: isoDateTime,
});
export const PortalFilesOutput = z.object({ files: z.array(PortalFileOut) });

export const FileShareToPortalInput = z.object({
  ...inWorkspace,
  fileId: uuid,
  shared: z.boolean(),
});
export const FileShareToPortalOutput = z.object({
  fileId: uuid,
  shared: z.boolean(),
  changed: z.boolean(),
});

// ---------- messages in the portal ----------

/** A client writes at most this many messages a day (a chat's daily cap's spirit, for one person). */
export const PORTAL_MESSAGES_PER_DAY = 100;

export const PortalMessageSendInput = z.object({
  ...inWorkspace,
  /** The record it's about (a deal); null for a portal with no records. */
  recordId: uuid.nullable().default(null),
  body: z
    .string()
    .trim()
    .min(1, 'Write a message.')
    .max(4000, 'Keep a message under 4,000 characters.'),
  /** The portal page's own id for it, so sending twice files it once. */
  clientId: z.string().trim().min(8).max(80),
});
export const PortalMessageSendOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  duplicate: z.boolean(),
});

export const PortalMessagesInput = z.object({
  ...inWorkspace,
  recordId: uuid.nullable().default(null),
  /** Older than this, for the next page. */
  before: isoDateTime.optional(),
});
export const PortalMessageOut = z.object({
  id: uuid,
  fromYou: z.boolean(),
  body: z.string(),
  at: isoDateTime,
  /** Who wrote it, for one from the business ("Dana Reyes"); null for their own, or someone who has left. */
  from: z.string().nullable(),
  /** Their own message reached the business; one from the business is marked seen once shown to them. */
  seen: z.boolean(),
});
export const PortalMessagesOutput = z.object({
  conversationId: uuid.nullable(),
  /** Newest last. */
  messages: z.array(PortalMessageOut),
  /** From the business, not yet shown to them. */
  unread: z.number().int(),
  hasMore: z.boolean(),
});

export const PortalMarkReadInput = z.object({
  ...inWorkspace,
  conversationId: uuid,
  throughMessageId: uuid,
});
export const PortalMarkReadOutput = z.object({ marked: z.number().int() });

export const PortalMarkSentInput = z.object({ ...inWorkspace, messageId: uuid });
export const PortalMarkSentOutput = z.object({ messageId: uuid, marked: z.boolean() });
