/**
 * A campaign email's unsubscribe page (`/u/<token>`) talking to the worker's `/public/unsubscribe` route. No
 * session: the token is the whole of the permission. Opening the page changes nothing (mail scanners follow
 * links); only the button's POST unsubscribes.
 */
import { publicEnv } from '../env';
import { ApiError } from './errors';

export interface UnsubscribeView {
  readonly business: string;
  /** Masked: `j•••@example.com`. */
  readonly address: string;
  readonly unsubscribed: boolean;
}

async function call(token: string, init: RequestInit): Promise<UnsubscribeView> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}/public/unsubscribe/${encodeURIComponent(token)}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...init,
    });
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach us just now. Check your connection and try again.',
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
    );
  }
  return json as UnsubscribeView;
}

export const getUnsubscribe = (token: string) => call(token, { method: 'GET' });
export const unsubscribe = (token: string) =>
  call(token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
