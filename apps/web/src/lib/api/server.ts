import { createApiClient, type ApiClient } from '@hfos/api-client';
import { redirect } from 'next/navigation';
import { publicEnv } from '../env';
import { getServerSession } from '../supabase/server';
import { ApiError, errorMessage, unwrap } from './errors';
import type { Me } from './types';

export { ApiError, errorMessage, unwrap };

/** Typed API client for Server Components; redirects to sign-in when there is no session. */
export async function apiServer(): Promise<{ api: ApiClient; userId: string; email: string }> {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');
  const api = createApiClient({
    baseUrl: publicEnv.apiUrl,
    getToken: () => session.accessToken,
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  });
  return { api, userId: session.userId, email: session.email };
}

/**
 * The signed-in user's profile, organizations and workspaces. A valid session whose account no longer
 * exists (deleted, or a reset local database) is signed out instead of erroring.
 */
export async function fetchMe(api: ApiClient): Promise<Me> {
  const result = await api.POST('/v1/queries/account.me', { body: {} });
  if (result.response.status === 404) redirect('/auth/sign-out?reason=account');
  return unwrap(result);
}
