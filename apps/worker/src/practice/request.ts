/**
 * Which practice business an HTTP request is worked for (Admin → Try onboarding), or null for a real one.
 *
 * A request names a business with its `workspaceId` or `organizationId`, but those are only what the caller typed, so
 * naming a practice business is never enough on its own. Practice mode swaps in the stand-ins (./kit.ts), whose
 * signing secrets and payment checks are pretend and public in this repository: a request that could turn it on for
 * itself could forge a webhook or "pay" a real invoice. So a request is worked for a practice business only when
 *
 * - it isn't a provider calling back (Twilio, Stripe, Square, PayPal, Postmark, Meta, Zoom, Microsoft, LiveKit…):
 *   those are always checked with the real secrets, and land in whichever business the real provider says; and
 * - the person signed in to it practises in that business: the staff member practising, or someone working in it.
 *
 * Everything else, a signed-out public page included, is worked for with the real services, as for any business.
 */
import type { PracticeRun } from './scope';

/** Where providers call us back. Never practice: their signatures are checked with the real secrets only. */
const PROVIDER_CALLBACK = /^\/(?:webhooks|meta)(?:\/|$)/i;

export interface PracticeRequestDeps {
  /** The practice business these ids name, or null for a real one (or none). */
  readonly runFor: (ids: {
    readonly organizationId?: unknown;
    readonly workspaceId?: unknown;
  }) => Promise<PracticeRun | null>;
  /** The person this request is signed in as, by id, or null when it isn't (or its token doesn't check out). */
  readonly signedIn: () => Promise<string | null>;
  /** Whether this person practises in, or works in, that practice organization. */
  readonly practises: (userId: string, organizationId: string) => Promise<boolean>;
}

export async function practiceForRequest(
  url: string,
  ids: { readonly organizationId?: unknown; readonly workspaceId?: unknown },
  deps: PracticeRequestDeps,
): Promise<PracticeRun | null> {
  const path = url.split('?')[0] ?? '';
  if (PROVIDER_CALLBACK.test(path)) return null;
  const run = await deps.runFor(ids);
  if (!run) return null;
  const userId = await deps.signedIn();
  if (!userId) return null;
  return (await deps.practises(userId, run.organizationId)) ? run : null;
}
