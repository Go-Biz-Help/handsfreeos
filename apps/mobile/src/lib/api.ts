import { createApiClient, isApiErrorBody, type ApiClient } from '@hfos/api-client';
import { APP_CLIENT, APP_HEADERS, VIEW_AS_HEADER } from '@hfos/core';
import * as Crypto from 'expo-crypto';

import { currentView } from '@/view-as/state';

import { appVersion } from './app-version';
import { session } from './auth';
import { config } from './config';
import { appFetch } from './network';

/**
 * Every request says it's the app and which build (core's `APP_HEADERS`, M10 step 4), and every command also says
 * which command it is and when it was done, because the API refuses one that doesn't. The queue of changes sends
 * its own commands (`src/changes/send.ts`), with the ids and moments it saved; a command sent straight through this
 * client says "now" (`saysWhichCommandAndWhen`).
 */
export { APP_CLIENT, APP_HEADERS };

/**
 * Every command from the app has to say which command it is and when it was done, or the API refuses it before it
 * even looks at the body — `assertAppRequest` in packages/core/src/kernel/app-request.ts, answering 400 with
 * "The app sent this change without saying which one it is and when it was done. Update the app, then try it again."
 *
 * The queue of changes says so for itself: each change it saved has its own id and the moment the person made it
 * (`src/changes/send.ts`). Everything else the app sends straight through this client — the Assistant's OK, a chat
 * renamed or archived, an account deleted — was done just now and has no saved moment, so it says so here, in the
 * one place every request passes, rather than at each call site, where forgetting it is silent until a phone is in
 * someone's hand. A fresh id each time is right for these: they aren't queued, so a second try is a second asking.
 */
function saysWhichCommandAndWhen(request: Request): void {
  if (!request.url.includes('/v1/commands/')) return;
  if (request.headers.get(APP_HEADERS.commandId)) return;
  const now = new Date().toISOString();
  request.headers.set(APP_HEADERS.commandId, Crypto.randomUUID());
  request.headers.set(APP_HEADERS.occurredAt, now);
  request.headers.set(APP_HEADERS.sentAt, now);
}

export function createAppApi(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = appFetch,
): ApiClient {
  const client = createApiClient({ baseUrl: config.apiUrl, getToken, fetch: fetchImpl });
  client.use({
    onRequest({ request }) {
      request.headers.set(APP_HEADERS.client, APP_CLIENT);
      request.headers.set(APP_HEADERS.appVersion, appVersion());
      saysWhichCommandAndWhen(request);
      // Viewing as a teammate (20261018000100): HandsFreeOS answers as them, and refuses a change in that business.
      const view = currentView();
      if (view && !request.headers.has(VIEW_AS_HEADER))
        request.headers.set(VIEW_AS_HEADER, view.viewId);
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
    /** Which rule refused it (`addon_needs`, `quiet_hours`…), when one did. */
    readonly rule: string | null = null,
    /** What the refusal carries for a screen to answer it with (the other add-ons to ask about, say). */
    readonly details: unknown = undefined,
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
      body.error.rule ?? null,
      body.error.details,
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
