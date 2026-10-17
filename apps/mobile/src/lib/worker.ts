import { ApiError } from '@/lib/api';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { appFetch } from '@/lib/network';

/**
 * A call to the worker's own routes, with the person's sign-in, refused in the API's shape so it reads the same way.
 * The worker holds what the API may not: the carrier's number search, the payment providers' sign-in, and the AI's
 * asks (the main offer's score and tries).
 */
export async function workerPost<T>(path: string, body: unknown): Promise<T> {
  // `accessToken()` is a promise: a token that ran out while the phone was offline is refreshed before it answers.
  const token = await session.accessToken();
  if (!token) throw new ApiError('Sign in to continue.', 401, 'unauthenticated', null);
  let res: Response;
  try {
    res = await appFetch(`${config.workerUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // No signal, as errorMessage words it.
    throw new TypeError('Network request failed');
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (
      json as {
        error?: { code?: string; message?: string; rule?: string; details?: unknown };
      } | null
    )?.error;
    throw new ApiError(
      err?.message ?? 'Something went wrong. Try again.',
      res.status,
      err?.code ?? 'internal',
      null,
      err?.rule ?? null,
      err?.details,
    );
  }
  return json as T;
}
