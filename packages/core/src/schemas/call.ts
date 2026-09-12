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
export const callAnsweredVia = z.enum(['browser', 'forwarding']);

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
    objectPath: z.string().min(3).max(500),
    seconds: z.number().int().min(0).max(3600),
    /** A message left after nobody answered (every recording in this milestone is one). */
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
