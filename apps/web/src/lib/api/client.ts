'use client';
import { createApiClient, type ApiClient } from '@hfos/api-client';
import { VIEW_AS_HEADER } from '@hfos/core';
import { installDemoFetch } from '../demo/browser';
import { publicEnv } from '../env';
import { browserAccessToken, renewedAccessToken } from '../supabase/token';
import { readViewCookie } from '../view-as';
import { ApiError, errorMessage, unwrap } from './errors';
import { mintCorrelationId } from './own-requests';

export { ApiError, errorMessage, unwrap };

let client: ApiClient | undefined;

/**
 * Sends a request, and once more with a renewed sign-in when the API says the sign-in is no good: it refuses that
 * before anything runs, so sending it again can't do anything twice. Looked up per request, so the demo player's
 * answers (lib/demo) reach this client too.
 */
async function sendSignedIn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!(input instanceof Request)) return globalThis.fetch(input, init);
  // The body read once, so the same bytes can go twice. (A cloned request's body goes as a stream, which the browser's
  // own tools, and the browser tests' `postDataJSON`, can't read.)
  const body = input.method === 'GET' || input.method === 'HEAD' ? null : await input.arrayBuffer();
  const res = await globalThis.fetch(new Request(input, { body }), init);
  if (res.status !== 401) return res;
  const token = await renewedAccessToken();
  if (!token) return res;
  const again = new Request(input, { body });
  again.headers.set('authorization', `Bearer ${token}`);
  return globalThis.fetch(again, init);
}

/**
 * Typed API client for Client Components; sends the current Supabase access token (judged by the server's clock, see
 * lib/supabase/token) and a correlation id, and the view the page is in when it's viewing as a teammate (read per
 * request, so starting or stopping one needs no new client).
 */
export function apiBrowser(): ApiClient {
  if (!client) {
    installDemoFetch();
    client = createApiClient({
      baseUrl: publicEnv.apiUrl,
      getToken: browserAccessToken,
      correlationId: mintCorrelationId,
      fetch: sendSignedIn,
    });
    client.use({
      onRequest({ request }) {
        const view = readViewCookie();
        if (view) request.headers.set(VIEW_AS_HEADER, view.viewId);
        return request;
      },
    });
  }
  return client;
}
