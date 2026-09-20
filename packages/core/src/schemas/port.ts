/**
 * Moving a number a business already owns (M17).
 *
 * The two kinds are the whole shape of this feature as a business experiences it, so they are named here in
 * the words a business would use rather than the carrier's:
 *
 * - `full` — texts **and** calls come to us. Two to four weeks, and the losing carrier can say no.
 * - `hosted_messaging` — texting only. Days, and their desk phone keeps ringing exactly where it does.
 *
 * **`submission` holds the losing carrier's credentials** — the account number on their bill and the PIN or
 * passcode. They never come back out of an output schema, are never synced to a phone, and are never logged.
 * That is why the output below says which fields have been *filled*, not what they say.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { phoneRequired } from './telephony';

export const numberPortKind = z.enum(['full', 'hosted_messaging']);
export type NumberPortKind = z.infer<typeof numberPortKind>;

export const numberPortStatus = z.enum([
  'draft',
  'submitted',
  'carrier_review',
  'scheduled',
  'complete',
  'rejected',
  'cancelled',
  'failed',
]);
export type NumberPortStatus = z.infer<typeof numberPortStatus>;

/** What the losing carrier wants before it will let a number go. */
export const PortSubmission = z.object({
  /** The account number on their bill — not the phone number. */
  accountNumber: z.string().trim().min(1).max(64),
  /** The PIN or passcode on that account. Some carriers call it a transfer PIN. */
  pin: z.string().trim().min(1).max(32),
  /** The name of whoever is authorised to move the number, as the carrier has it. */
  authorizedBy: z.string().trim().min(2).max(120),
  /** The service address on the account, as the carrier has it, down to the postcode. */
  serviceAddress: z.string().trim().min(5).max(300),
  /** Where the carrier writes back, if it writes to anybody. */
  email: z.string().trim().email().max(200).optional(),
});

export const NumberPortStartInput = z.object({
  workspaceId: uuid,
  e164: phoneRequired,
  kind: numberPortKind,
});
export const NumberPortRefOutput = z.object({ portId: uuid, status: numberPortStatus });

export const NumberPortSaveInput = z.object({
  workspaceId: uuid,
  portId: uuid,
  submission: PortSubmission,
});

/** Which paper this is. The carrier asks for the signed authorisation and usually a recent bill. */
export const numberPortDocument = z.enum(['loa', 'bill']);
export type NumberPortDocument = z.infer<typeof numberPortDocument>;

/** Reserve a place for one of those papers. The same two-step every other upload here uses. */
export const NumberPortBeginUploadInput = z.object({
  workspaceId: uuid,
  portId: uuid,
  document: numberPortDocument,
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(120),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});
export const NumberPortBeginUploadOutput = z.object({
  fileId: uuid,
  bucket: z.literal('attachments'),
  objectPath: z.string(),
});

export const NumberPortAttachInput = z.object({
  workspaceId: uuid,
  portId: uuid,
  document: numberPortDocument,
  /** A file already reserved by `number_port.begin_upload` and made ready by `file.confirm`. */
  fileId: uuid,
});

export const NumberPortSubmitInput = z.object({ workspaceId: uuid, portId: uuid });
export const NumberPortCancelInput = z.object({ workspaceId: uuid, portId: uuid });

/** Worker only: what the carrier said. */
export const NumberPortRecordStateInput = z.object({
  workspaceId: uuid,
  portId: uuid,
  status: numberPortStatus,
  providerSid: z.string().trim().min(2).max(64).nullable(),
  providerStatus: z.string().trim().max(120).nullable(),
  rejectionReason: z.string().trim().max(2000).nullable(),
  /** The day the carrier commits to. A business plans its week around this one. */
  scheduledFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  nextPollAt: isoDateTime.nullable(),
});

/** Worker only: it landed. The number becomes this business's, and can send. */
export const NumberPortCompleteInput = z.object({
  workspaceId: uuid,
  portId: uuid,
  providerSid: z.string().trim().min(2).max(64),
});
export const NumberPortCompleteOutput = z.object({
  portId: uuid,
  phoneNumberId: uuid,
});

export const NumberPortOut = z.object({
  id: uuid,
  e164: z.string(),
  display: z.string(),
  kind: numberPortKind,
  status: numberPortStatus,
  /** Which papers are in. Never what they say, and never the account number or PIN. */
  documents: z.object({ loa: z.boolean(), bill: z.boolean() }),
  /** True once the account number, PIN, name and address are all filled in. */
  detailsReady: z.boolean(),
  rejectionReason: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export const NumberPortListInput = z.object({
  workspaceId: uuid,
  /** Ports that already landed are history; off by default so the screen is about what is in flight. */
  includeFinished: z.boolean().optional().default(false),
});
export const NumberPortListOutput = z.object({ ports: z.array(NumberPortOut) });
