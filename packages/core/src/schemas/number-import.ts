/**
 * Bringing a number that already lives in Twilio (20261010000900): from the business's own Twilio account, or
 * from GoHighLevel / LeadConnector. See `messaging/number-import.ts` for the shape of the feature.
 *
 * **Two tracks, never merged.** `setup` is the number itself — waiting for the transfer, then live here with our
 * webhooks on it. `texting` is the carrier registration (A2P 10DLC, or toll-free verification), which a number
 * does not bring with it. A number can be live and ringing the inbox while texting still waits.
 */
import { z } from 'zod';
import { ACCOUNT_SID, API_KEY_SID, NUMBER_SID } from '../messaging/number-import';
import { isoDateTime, uuid } from './common';
import { phoneRequired } from './telephony';

export const numberImportSource = z.enum(['twilio', 'highlevel']);
export type NumberImportSource = z.infer<typeof numberImportSource>;

export const numberImportStatus = z.enum(['waiting', 'complete', 'failed', 'cancelled']);
export type NumberImportStatus = z.infer<typeof numberImportStatus>;

export const twilioAccountSid = z
  .string()
  .trim()
  .regex(ACCOUNT_SID, 'A Twilio Account SID starts with AC.');
export const twilioNumberSid = z
  .string()
  .trim()
  .regex(NUMBER_SID, 'A Twilio phone number SID starts with PN.');
export const twilioApiKeySid = z
  .string()
  .trim()
  .regex(API_KEY_SID, 'A Twilio API key SID starts with SK.');

export const NumberImportStartInput = z
  .object({
    workspaceId: uuid,
    e164: phoneRequired,
    source: numberImportSource,
    /** The connected Twilio account it was picked from (the organization's), when it was picked. */
    connectionId: uuid.optional(),
    /** The account holding it today and its id there, as the connected account listed them. */
    sourceAccountSid: twilioAccountSid.optional(),
    sourceNumberSid: twilioNumberSid.optional(),
  })
  .refine((v) => v.source === 'twilio' || (!v.connectionId && !v.sourceNumberSid), {
    message: 'A HighLevel number is not picked from a connected Twilio account.',
    path: ['connectionId'],
  });
export const NumberImportRefOutput = z.object({ importId: uuid, status: numberImportStatus });

export const NumberImportCancelInput = z.object({ workspaceId: uuid, importId: uuid });
export const NumberImportCheckNowInput = z.object({ workspaceId: uuid, importId: uuid });

/** Worker only: what one look for the number found. */
export const NumberImportRecordCheckInput = z.object({
  workspaceId: uuid,
  importId: uuid,
  /** The workspace's subaccount, once it exists: where the owner asks for the number to be sent. */
  destination: z.object({ accountId: uuid, accountSid: twilioAccountSid }).nullable().optional(),
  /** Who hosts the number, by the carrier lookup. Written once. */
  carrier: z
    .object({ name: z.string().trim().max(200).nullable(), hostedInTwilio: z.boolean() })
    .nullable()
    .optional(),
  /** Why the last look could not finish, in words for the business; null clears it. */
  lastError: z.string().trim().max(2000).nullable(),
  nextPollAt: isoDateTime.nullable(),
});

/** Worker only: the number is in the workspace's subaccount with our webhooks on it. */
export const NumberImportCompleteInput = z.object({
  workspaceId: uuid,
  importId: uuid,
  accountId: uuid,
  providerSid: twilioNumberSid,
  numberType: z.enum(['local', 'toll_free']),
  capabilities: z.object({ sms: z.boolean(), mms: z.boolean(), voice: z.boolean() }),
});
export const NumberImportCompleteOutput = z.object({ importId: uuid, phoneNumberId: uuid });

/** Worker only: it cannot finish, and the business is told why. */
export const NumberImportFailInput = z.object({
  workspaceId: uuid,
  importId: uuid,
  reason: z.string().trim().min(1).max(2000),
});

/** Where texting stands for the number: the carrier registration, apart from the number itself. */
export const importTextingState = z.enum([
  'needs_registration',
  'in_review',
  'approved',
  'rejected',
]);

export const NumberImportOut = z.object({
  id: uuid,
  e164: z.string(),
  display: z.string(),
  source: numberImportSource,
  status: numberImportStatus,
  numberType: z.enum(['local', 'toll_free']),
  /** Picked from a connected Twilio account, rather than typed in. */
  connectionId: uuid.nullable(),
  sourceAccountSid: z.string().nullable(),
  sourceNumberSid: z.string().nullable(),
  /** What the carrier lookup said. Null until it has been looked up. */
  carrierName: z.string().nullable(),
  hostedInTwilio: z.boolean().nullable(),
  /**
   * The workspace's own subaccount: where to send the number. Null for the moment it takes to make one. The
   * request to copy is written from this on the screen (`transferRequestText`), together with HandsFreeOS's
   * parent Account SID, which only the worker knows.
   */
  destinationAccountSid: z.string().nullable(),
  phoneNumberId: uuid.nullable(),
  /** The number itself: waiting for the transfer, live here, or stopped. */
  setup: z.enum(['waiting_for_transfer', 'live', 'failed', 'cancelled']),
  /** Texting registration, apart from the number. What it will need even before it lands. */
  texting: importTextingState,
  lastError: z.string().nullable(),
  lastCheckedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export const NumberImportListInput = z.object({
  workspaceId: uuid,
  /** Finished imports are history; off by default so the screen is about what is still coming. */
  includeFinished: z.boolean().optional().default(false),
});
export const NumberImportListOutput = z.object({
  imports: z.array(NumberImportOut),
  /** Numbers a GoHighLevel migration found this business using, not on their way here yet (M11). */
  fromMigration: z.array(z.object({ e164: z.string(), display: z.string() })),
});

// ---------- connected Twilio accounts ----------

export const TwilioConnectionOut = z.object({
  id: uuid,
  accountSid: z.string(),
  friendlyName: z.string().nullable(),
  /** Connected with an API key rather than the account's own auth token. */
  usesApiKey: z.boolean(),
  status: z.enum(['active', 'broken', 'disconnected']),
  lastError: z.string().nullable(),
  checkedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export const TwilioConnectionListInput = z.object({ workspaceId: uuid });
export const TwilioConnectionListOutput = z.object({
  /** Owners and admins of the organization connect accounts: one account's numbers are every business's. */
  canConnect: z.boolean(),
  connections: z.array(TwilioConnectionOut),
  /** The businesses in this organization a number can be assigned to by this person. */
  workspaces: z.array(z.object({ id: uuid, name: z.string() })),
});

/** What the worker's connect route takes: the Account SID, and either its auth token or an API key. */
export const TwilioConnectInput = z
  .object({
    workspaceId: uuid,
    accountSid: twilioAccountSid,
    /** The account's auth token. Or leave it out and give an API key. */
    authToken: z.string().trim().min(16).max(128).optional(),
    apiKeySid: twilioApiKeySid.optional(),
    apiKeySecret: z.string().trim().min(16).max(128).optional(),
  })
  .refine((v) => !!v.authToken !== !!(v.apiKeySid && v.apiKeySecret), {
    message: 'Give the auth token, or an API key SID with its secret — one or the other.',
    path: ['authToken'],
  });

/** Worker only: a Twilio account the business connected, checked with Twilio and its secret sealed. */
export const TwilioConnectionSaveInput = z.object({
  organizationId: uuid,
  accountSid: twilioAccountSid,
  friendlyName: z.string().trim().max(200).nullable(),
  apiKeySid: twilioApiKeySid.nullable(),
  /** Sealed by the worker before it gets here. Never the secret itself. */
  secretEnc: z.string().min(1).max(4000),
  keyId: z.string().min(1).max(200),
});
export const TwilioConnectionRefOutput = z.object({ connectionId: uuid });

/** Worker only: let a connection go (the secret is wiped), or say Twilio stopped accepting it. */
export const TwilioConnectionDisconnectInput = z.object({
  organizationId: uuid,
  connectionId: uuid,
});
export const TwilioConnectionFailInput = z.object({
  organizationId: uuid,
  connectionId: uuid,
  reason: z.string().trim().min(1).max(2000),
});
