/**
 * AI outbound calls: the AI teammate rings a customer itself, for one of four reasons, in open hours and never in
 * quiet hours, saying it's an AI and that the call is recorded. While it's training, a person approves each call
 * first (a `call` draft); a quote follow-up always waits for a person.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/** Why it calls. */
export const AI_CALL_PURPOSES = ['confirm_visit', 'missed_call', 'quote', 'campaign'] as const;
export const aiCallPurpose = z.enum(AI_CALL_PURPOSES);
export type AiCallPurpose = z.infer<typeof aiCallPurpose>;

/** Written consent to calls: the same three states as texts (schemas/conversation's `smsConsent`, which imports
 * the teammate's schemas, so it isn't imported here). */
export const callConsent = z.enum(['unknown', 'opted_in', 'opted_out']);

export const AI_CALL_STATUSES = [
  'awaiting_approval',
  'queued',
  'calling',
  'done',
  'skipped',
  'cancelled',
  'failed',
] as const;
export const aiCallStatus = z.enum(AI_CALL_STATUSES);
export type AiCallStatus = z.infer<typeof aiCallStatus>;

export const AI_CALL_OUTCOMES = ['talked', 'voicemail', 'no_answer', 'busy', 'failed'] as const;
export const aiCallOutcome = z.enum(AI_CALL_OUTCOMES);
export type AiCallOutcome = z.infer<typeof aiCallOutcome>;

/** What a call draft shows the person approving it. */
export const DraftCall = z.object({
  aiCallId: uuid,
  purpose: aiCallPurpose,
  /** "+17135550100" and how it reads. */
  to: z.string(),
  toDisplay: z.string(),
  /** What the AI will say it's calling about, in a line. */
  goal: z.string(),
});
export type DraftCall = z.infer<typeof DraftCall>;

// ---------- person.set_call_consent ----------

export const PersonSetCallConsentInput = z
  .object({
    workspaceId: uuid,
    personId: uuid,
    consent: z.enum(['opted_in', 'opted_out']),
    /** Where the written consent is ("Signed service agreement"). Needed to record a yes. */
    source: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.consent === 'opted_out' || !!v.source, {
    path: ['source'],
    error: 'Say where they agreed in writing.',
  });
export const PersonSetCallConsentOutput = z.object({
  personId: uuid,
  consent: callConsent,
  source: z.string().nullable(),
  at: isoDateTime.nullable(),
});
