'use client';
import { createApiClient, type ApiClient } from '@hfos/api-client';
import { VIEW_AS_HEADER } from '@hfos/core';
import { installDemoFetch } from '../demo/browser';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import { readViewCookie } from '../view-as';
import { ApiError, errorMessage, unwrap } from './errors';
import { mintCorrelationId } from './own-requests';

export { ApiError, errorMessage, unwrap };

let client: ApiClient | undefined;

/**
 * Typed API client for Client Components; sends the current Supabase access token and a correlation id, and the view
 * the page is in when it's viewing as a teammate (read per request, so starting or stopping one needs no new client).
 */
export function apiBrowser(): ApiClient {
  if (!client) {
    installDemoFetch();
    client = createApiClient({
      baseUrl: publicEnv.apiUrl,
      getToken: async () =>
        (await supabaseBrowser().auth.getSession()).data.session?.access_token ?? null,
      correlationId: mintCorrelationId,
      // Looked up per request, so the demo player's answers (lib/demo) reach this client too.
      fetch: (input, init) => globalThis.fetch(input, init),
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
