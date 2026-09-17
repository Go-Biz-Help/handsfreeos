import { createApiClient, isApiErrorBody, type ApiClient } from '@hfos/api-client';
import { APP_CLIENT, APP_HEADERS } from '@hfos/core';

import { appVersion } from './app-version';
import { session } from './auth';
import { config } from './config';
import { appFetch } from './network';

/**
 * Every request says it's the app and which build (core's `APP_HEADERS`, M10 step 4); the queue of changes sends its
 * commands itself (`src/changes/send.ts`), with their ids and the moments they were done and sent.
 */
export { APP_CLIENT, APP_HEADERS };

export function createAppApi(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = appFetch,
): ApiClient {
  const client = createApiClient({ baseUrl: config.apiUrl, getToken, fetch: fetchImpl });
  client.use({
    onRequest({ request }) {
      request.headers.set(APP_HEADERS.client, APP_CLIENT);
      request.headers.set(APP_HEADERS.appVersion, appVersion());
      return request;
    },
  });
  return client;
}

/** The API, with the signed-in person's access token. */
export const api = createAppApi(() => session.accessToken());

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly disposition: 'final' | 'retry' | 'ask' | null,
  ) {
    super(message);
  }
}

/** The data of an API answer, or an ApiError with the API's own words. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined && result.response.ok) return result.data;
  const body = result.error;
  if (isApiErrorBody(body))
    throw new ApiError(
      body.error.message,
      result.response.status,
      body.error.code,
      body.error.disposition ?? null,
    );
  throw new ApiError('Something went wrong. Try again.', result.response.status, 'unknown', null);
}

/** Words for a failed request: the API's own, or no signal. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 426)
      return 'This version of HandsFreeOS is too old. Update it to keep going.';
    if (error.status === 401) return 'Your sign-in needs checking. Try again in a moment.';
    return error.message;
  }
  if (error instanceof TypeError) return 'No signal. Try again when you’re back online.';
  return 'Something went wrong. Try again.';
}
