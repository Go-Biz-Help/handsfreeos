import { createApiClient, isApiErrorBody, type ApiClient } from '@hfos/api-client';
import { NO_SUCH_ROUTE } from '@hfos/core';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { publicEnv } from '../env';
import { getServerSession } from '../supabase/server';
import { ApiError, errorMessage, unwrap } from './errors';
import type { Me } from './types';

export { ApiError, errorMessage, unwrap };

/**
 * `unwrap` for page loads: a 404 from the API renders the 404 page instead of a server error, so a
 * non-member never learns whether a workspace exists and the logs stay quiet.
 *
 * **Except a 404 that means the API has no such route.** This app ships the moment main moves; the API
 * ships after CI passes, twenty-odd minutes later. In between, a page built from the new commit asks for
 * endpoints the running API does not have yet, and every one of them answers 404. Reading those as real
 * 404s put "The page does not exist, or you do not have access to it" on whole settings pages that were
 * fine — the worst thing this screen can say, because it blames the person's account for a deploy that is
 * simply still in flight. A route the API does not know is server trouble, so it throws and is reported as
 * one: wrong for a minute and then right, rather than wrong about whose fault it is.
 */
export function unwrapPage<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.status === 404 && !isNoSuchRoute(result.error)) notFound();
  return unwrap(result);
}

/** True when a 404 came from the API's router rather than from anything the request asked for. */
function isNoSuchRoute(body: unknown): boolean {
  return isApiErrorBody(body) && body.error.rule === NO_SUCH_ROUTE;
}

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
 *
 * Fetched once per request: the layout and the page both ask for it, and a live refresh renders both again.
 */
export const getMe = cache(async (): Promise<Me> => {
  const { api } = await apiServer();
  const result = await api.POST('/v1/queries/account.me', { body: {} });
  if (result.response.status === 404) redirect('/auth/sign-out?reason=account');
  return unwrap(result);
});
