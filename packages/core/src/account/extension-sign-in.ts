/**
 * The shapes on the wire for approving an extension sign-in (20261027002900); the words, numbers and times are in
 * ./extension-sign-in-words.ts, which the extension imports without zod.
 */
import { z } from 'zod';
import { email, uuid } from '../schemas/common';

export * from './extension-sign-in-words';

// ---------- the worker's public doors (the extension) ----------

export const ExtensionSignInStartInput = z.object({
  email,
  /** Which browser is asking ("Chrome"). */
  browser: z.string().trim().min(1).max(40).default('Chrome'),
});
export type ExtensionSignInStartInput = z.infer<typeof ExtensionSignInStartInput>;

/** The same answer whether or not the email has an account. */
export const ExtensionSignInStartOutput = z.object({
  requestId: uuid,
  number: z.number().int().min(10).max(99),
  /** The extension's secret for this request: needed to collect it, and never stored by HandsFreeOS. */
  secret: z.string().min(32).max(128),
  expiresAt: z.iso.datetime(),
});
export type ExtensionSignInStartOutput = z.infer<typeof ExtensionSignInStartOutput>;

export const ExtensionSignInCollectInput = z.object({
  requestId: uuid,
  secret: z.string().min(32).max(128),
});
export type ExtensionSignInCollectInput = z.infer<typeof ExtensionSignInCollectInput>;

export const ExtensionSignInCollectOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('waiting') }),
  z.object({ status: z.literal('refused') }),
  z.object({ status: z.literal('expired') }),
  /** Redeemed with Supabase Auth's verifyOtp({ token_hash, type: 'email' }). Once only. */
  z.object({ status: z.literal('approved'), tokenHash: z.string().min(1).max(512) }),
]);
export type ExtensionSignInCollectOutput = z.infer<typeof ExtensionSignInCollectOutput>;

// ---------- the person's side (the API) ----------

export const ExtensionSignInPendingInput = z.object({});
export const ExtensionSignInPendingOutput = z.object({
  /** The person's requests still waiting, newest first. Never the number itself. */
  requests: z.array(
    z.object({
      id: uuid,
      browser: z.string(),
      choices: z.array(z.number().int()).length(3),
      expiresAt: z.iso.datetime(),
    }),
  ),
});
export type ExtensionSignInPending = z.infer<
  typeof ExtensionSignInPendingOutput
>['requests'][number];

export const ExtensionSignInAnswerInput = z.object({
  requestId: uuid,
  /** The number picked; null for "That wasn't me". */
  pick: z.number().int().min(10).max(99).nullable(),
});
export const ExtensionSignInAnswerOutput = z.object({
  outcome: z.enum(['approved', 'refused']),
});
