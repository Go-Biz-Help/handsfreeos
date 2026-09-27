/**
 * Finishing a sign-in in the app, as the person who started it (SEC-M1, SEC-M7).
 *
 * A sign-in's one-time state says which business a connection is for, and it travels in a link. So a link can be
 * forwarded: somebody in one business starts connecting Stripe, sends the link to somebody in another, and the
 * account that second person approves is connected to the first business. Nothing at the provider can tell them
 * apart, and the callback is a plain browser visit with nobody signed in to this server.
 *
 * So the callback no longer connects anything. It seals what the provider sent back — the code or the refusal,
 * with the state it answered, good for the state's own ten minutes — and sends the browser to the app's
 * `/app/oauth/finish`, with the seal after the `#` so it never reaches a log. The app, signed in, posts it back to
 * `/v1/oauth/finish` (or `/v1/migrations/finish`), and only there, and only for the person who pressed Connect,
 * is the code exchanged and the account connected. A forwarded link ends on a page that says it was somebody
 * else's, and nothing is kept.
 *
 * The seal is the worker's own (AES-256-GCM), so nobody can make one or change one, and the provider's code is
 * never readable in the address bar it passes through.
 */
import { z } from 'zod';
import type { Sealer } from '../crypto';

/** Which callback sealed it: one business's connections, or the CRM an organization is leaving. */
export type HandoffDoor = 'oauth' | 'migration';

export interface Handoff {
  readonly door: HandoffDoor;
  /** The provider in the callback's address (`stripe`, `google` …); empty for a migration. */
  readonly provider: string;
  /** The hash of the state the provider answered, which is what finds the connection again. */
  readonly stateHash: string;
  readonly code: string | null;
  readonly error: string | null;
  readonly errorDescription: string | null;
}

/** As long as the state it answered: the same ten minutes. */
const HANDOFF_TTL_MS = 10 * 60_000;

/** What the app posts back. A seal is a few hundred characters; this is past any honest one. */
export const HandoffBody = z.object({ handoff: z.string().min(1).max(8000) });

export function sealHandoff(sealer: Sealer, h: Handoff, now = Date.now()): string {
  return sealer.seal(
    JSON.stringify({ kind: 'sign_in_handoff', ...h, expiresAt: now + HANDOFF_TTL_MS }),
  );
}

/** The handoff, if it is the worker's own, for this door, and still within its ten minutes. */
export function openHandoff(
  sealer: Sealer,
  sealed: string,
  door: HandoffDoor,
  now = Date.now(),
): Handoff | null {
  let raw: unknown;
  try {
    raw = JSON.parse(sealer.open(sealed));
  } catch {
    return null;
  }
  const h = raw as Partial<Handoff> & { kind?: unknown; expiresAt?: unknown };
  if (
    h.kind !== 'sign_in_handoff' ||
    h.door !== door ||
    typeof h.stateHash !== 'string' ||
    typeof h.provider !== 'string' ||
    typeof h.expiresAt !== 'number' ||
    h.expiresAt < now
  )
    return null;
  return {
    door,
    provider: h.provider,
    stateHash: h.stateHash,
    code: typeof h.code === 'string' ? h.code : null,
    error: typeof h.error === 'string' ? h.error : null,
    errorDescription: typeof h.errorDescription === 'string' ? h.errorDescription : null,
  };
}

/**
 * The app's page that finishes it, and which door it posts back to. The seal rides after the `#`, which
 * browsers never send anywhere.
 */
export const finishUrl = (webUrl: string, door: HandoffDoor, sealed: string): string =>
  `${webUrl}/app/oauth/finish?door=${door}#${encodeURIComponent(sealed)}`;

/** A page the app shows in words, for the dead ends a sign-in can reach. */
export interface FinishPage {
  readonly title: string;
  readonly body: string;
  readonly link?: { readonly href: string; readonly label: string };
}

/**
 * What finishing answers: somewhere to go next, a page to show, or (a review sign-in that speaks for several
 * places) the question of which one.
 */
export type FinishOutcome =
  | { readonly next: string }
  | { readonly page: FinishPage }
  | { readonly choose: { readonly places: readonly { id: string; name: string }[] } };

/** A sign-in finished by somebody other than the person who started it. */
export const NOT_YOURS: FinishPage = {
  title: 'This sign-in was started by someone else',
  body:
    'Only the person who pressed Connect can finish connecting an account, so nothing was connected. ' +
    'If somebody sent you this link, don’t use it: connect your own account from your own Settings.',
};
