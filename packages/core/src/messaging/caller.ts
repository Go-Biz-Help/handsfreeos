/**
 * Whether a caller is who their caller ID says (AI1). Anyone can set the number a call shows, so a call proves the
 * caller only when:
 * - the business placed it (it reached the number on file, whoever answers there);
 * - the phone company vouched for the number: Twilio's `StirVerstat` on an inbound call is `TN-Validation-Passed-A`
 *   (STIR/SHAKEN's full attestation: the caller's own carrier knows them and the number is theirs). B, C, a failed
 *   check, no check, or nothing at all prove nothing;
 * - or, during the call, the caller read back a code sent to the phone (or else the email) on file for the customer
 *   the call matched (`call.check_code_for_customer`, the owner's "Text a code first", 22 Nov 2026).
 *
 * Calls from before attestations were recorded have none, so they prove nothing either. The AI phone teammate,
 * the commands it runs and contact AI all decide it here.
 */

/** The one attestation that proves a caller's number. */
export const PROVEN_ATTESTATION = 'TN-Validation-Passed-A';

/** What a call says about its caller, as `calls` keeps it. */
export interface CallerFacts {
  readonly direction: 'inbound' | 'outbound';
  /** calls.caller_attestation: Twilio's StirVerstat for an inbound call, or null. */
  readonly callerAttestation: string | null;
  /** calls.caller_verified_at: when they read back a code sent to the contact on file, or null. */
  readonly callerVerifiedAt: Date | string | null;
}

/** Whether the person on this call is proven to be the one whose number it is (see above). */
export function callerProven(c: CallerFacts): boolean {
  if (c.direction === 'outbound') return true;
  return c.callerAttestation === PROVEN_ATTESTATION || !!c.callerVerifiedAt;
}

/** Twilio's StirVerstat as it may be kept: letters, digits and dashes, at most 64; anything else is none. */
export function callerAttestationOf(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : null;
}
