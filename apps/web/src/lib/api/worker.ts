'use client';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import { ApiError } from './errors';
import { mintCorrelationId } from './own-requests';

/**
 * Calls the worker's own HTTP routes (number search now; voice tokens and mailbox sign-in later) with the
 * signed-in user's access token. Errors come back in the API's shape, so callers handle them the same way.
 */
export async function workerPost<T>(path: string, body: unknown): Promise<T> {
  const token = (await supabaseBrowser().auth.getSession()).data.session?.access_token;
  if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-correlation-id': mintCorrelationId(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'internal',
      'The phone service is not reachable right now. Try again in a minute.',
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (
      json as {
        error?: { code?: string; message?: string; rule?: string; details?: unknown };
      } | null
    )?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.rule,
      err?.details,
    );
  }
  return json as T;
}

export interface AvailableNumber {
  readonly e164: string;
  readonly display: string;
  readonly locality: string | null;
  readonly region: string | null;
  readonly capabilities: { readonly sms: boolean; readonly mms: boolean; readonly voice: boolean };
}

/** Numbers the carrier has free right now (owners and admins only; the worker checks). */
export function searchNumbers(input: {
  workspaceId: string;
  numberType: 'local' | 'toll_free';
  areaCode?: string;
  contains?: string;
}): Promise<{ numbers: AvailableNumber[] }> {
  return workerPost('/v1/telephony/available-numbers', input);
}
