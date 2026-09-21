import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { e164Phone, phoneRequired } from './telephony';

export const callStatus = z.enum([
  'initiated',
  'ringing',
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'canceled',
]);
export type CallStatus = z.infer<typeof callStatus>;
/** A teammate's browser, a forwarding phone, or the person's own cell (a call through it: call.connect_me). */
export const callAnsweredVia = z.enum(['browser', 'forwarding', 'bridge']);

const callRef = {
  callId: uuid.optional(),
  providerSid: z.string().trim().min(2).max(64).optional(),
};
const namesTheCall = (v: { callId?: string; providerSid?: string }) =>
  !!v.callId || !!v.providerSid;

export const CallStartInput = z
  .object({
    workspaceId: uuid,
    conversationId: uuid.optional(),
    personId: uuid.optional(),
    toPhone: phoneRequired.optional(),
  })
  .refine((v) => [v.conversationId, v.personId, v.toPhone].filter(Boolean).length === 1, {
    path: ['personId'],
    error: 'Pick one conversation, customer or number.',
  });
export const CallStartOutput = z.object({
  callId: uuid,
  conversationId: uuid,
  to: z.string(),
  /** What the browser passes to Device.connect; the worker's TwiML app reads them. */
  params: z.record(z.string(), z.string()),
});

/**
 * Calling a customer through your own cell. The number HandsFreeOS dials is always one the business already has:
 * a conversation's, a customer's, or a number one of them has (never any number typed in).
 */
export const CallConnectMeInput = z
  .object({
    workspaceId: uuid,
    conversationId: uuid.optional(),
    personId: uuid.optional(),
    /** A number a customer or conversation of this business already has. */
    toPhone: phoneRequired.optional(),
  })
  .refine((v) => [v.conversationId, v.personId, v.toPhone].filter(Boolean).length === 1, {
    path: ['personId'],
    error: 'Pick one conversation, customer or number.',
  });
export const CallConnectMeOutput = z.object({
  callId: uuid,
  conversationId: uuid,
  /** The customer's number: it rings once the person presses 1. */
  to: z.string(),
  /** The person's own verified cell, which HandsFreeOS rings first. */
  cell: z.string(),
  /** The business number both phones see. */
  callerId: z.string(),
  /** Pressed again while that call was still ringing: the same call. */
  duplicate: z.boolean(),
});

/**
 * Cancel a call through your own cell before the customer picks up (the call sheet's Cancel): HandsFreeOS hangs up,
 * and you can call again at once.
 */
export const CallCancelConnectInput = z.object({ workspaceId: uuid, callId: uuid });
export const CallCancelConnectOutput = z.object({
  callId: uuid,
  /** False when the call had already ended. */
  cancelled: z.boolean(),
});

// ---------- worker-only (system actor) ----------
export const CallRecordInput = z.object({
  workspaceId: uuid,
  providerSid: z.string().trim().min(2).max(64),
  direction: z.enum(['inbound', 'outbound']),
  from: e164Phone,
  to: e164Phone,
  /** A call a teammate placed from the browser (call.start made the row). */
  callId: uuid.optional(),
  status: callStatus.default('ringing'),
  startedAt: isoDateTime.optional(),
});
export const CallRecordOutput = z.object({
  callId: uuid,
  conversationId: uuid.nullable(),
  duplicate: z.boolean(),
});

export const CallUpdateStatusInput = z
  .object({
    workspaceId: uuid,
    ...callRef,
    status: callStatus.exclude(['initiated']),
    answeredVia: callAnsweredVia.optional(),
    answeredByUserId: uuid.nullable().optional(),
    answeredNumber: e164Phone.nullable().optional(),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    at: isoDateTime.optional(),
  })
  .refine(namesTheCall, { path: ['callId'], error: 'Name the call.' });
export const CallUpdateStatusOutput = z.object({
  callId: uuid,
  status: callStatus,
  changed: z.boolean(),
});

export const CallAttachRecordingInput = z
  .object({
    workspaceId: uuid,
    ...callRef,
    recordingSid: z.string().trim().min(2).max(64),
    /**
     * Where our copy of the audio is kept, or null while there isn't one. The call is a voicemail the moment the
     * carrier says a message was left; storing the audio is a separate step that can fail, be retried, or (for a
     * business whose storage is misconfigured) never happen. A voicemail with no path still shows, still gets its
     * words, and still tells the AI what the caller wanted.
     */
    objectPath: z.string().min(3).max(500).nullish(),
    seconds: z.number().int().min(0).max(3600),
    /** A message left after nobody answered; false for a call through a person's own cell, recorded whole. */
    voicemail: z.boolean().default(true),
  })
  .refine(namesTheCall, { path: ['callId'], error: 'Name the call.' });
export const CallAttachTranscriptInput = z
  .object({
    workspaceId: uuid,
    ...callRef,
    transcript: z.string().trim().max(10_000).nullable(),
    status: z.enum(['completed', 'failed']),
  })
  .refine(namesTheCall, { path: ['callId'], error: 'Name the call.' });
export const CallRefOutput = z.object({ callId: uuid });
