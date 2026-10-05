/**
 * An outside safety contact's page (`/s/<token>`, round six) talking to the worker's `/public/safety` routes
 * (apps/worker/src/http/safety.ts). No session: the contact is signed out and the token in the address is the whole of
 * the permission, so every call is made from their own browser (the worker's per-address limits then count per
 * person), never cached and never sent on as a referrer.
 *
 * Modelled on `public-money.ts`, and the same rule holds: **anything that changes something is a POST**, because mail
 * scanners follow links. Opening the page changes nothing.
 */
import { publicEnv } from '../env';
import { ApiError } from './errors';

/** Never cached, and the token never travels on as a referrer. */
const PRIVATE: RequestInit = { cache: 'no-store', referrerPolicy: 'no-referrer' };

/** While the person is still being told about: just this check-in. */
export interface SafetyLinkOpen {
  readonly open: true;
  readonly person: string;
  readonly first: string;
  readonly business: string;
  /** They pressed Help rather than missing their check-out. */
  readonly help: boolean;
  readonly place: string;
  /** "4:45 PM", where the business is. */
  readonly plannedEnd: string;
  readonly checkedIn: string;
  readonly located: {
    readonly latitude: number;
    readonly longitude: number;
    readonly at: string | null;
  } | null;
  /** E.164, for the call button. */
  readonly phone: string | null;
  /** "(512) 555-0101". */
  readonly phoneWords: string | null;
}

/** Once someone said they're OK, or they checked out: only that it's over. */
export interface SafetyLinkSettled {
  readonly open: false;
  readonly person: string;
  readonly business: string;
  readonly settled: 'ok' | 'checked_out';
}

export type SafetyLinkView = SafetyLinkOpen | SafetyLinkSettled;

type ErrorBody = {
  error?: { code?: string; message?: string; rule?: string; details?: unknown };
} | null;

async function call(path: string, init: RequestInit): Promise<SafetyLinkView> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, { ...PRIVATE, ...init });
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach HandsFreeOS just now. Check your connection and try again, or call them yourself.',
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ErrorBody)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Try again, or call them yourself.',
      err?.rule,
      err?.details,
    );
  }
  return json as SafetyLinkView;
}

const linkPath = (token: string) => `/public/safety/${encodeURIComponent(token)}`;

export const getSafetyLink = (token: string) => call(linkPath(token), { method: 'GET' });

/** "I reached them, they're OK" (`ok`) stops the alerts for everyone; "I couldn't reach them" tells the teammates. */
export const answerSafetyLink = (token: string, how: 'ok' | 'unreached') =>
  call(`${linkPath(token)}/${how}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
