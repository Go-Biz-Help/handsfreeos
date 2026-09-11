'use client';
import { createApiClient, type ApiClient } from '@hfos/api-client';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import { ApiError, errorMessage, unwrap } from './errors';
import { mintCorrelationId } from './own-requests';

export { ApiError, errorMessage, unwrap };

let client: ApiClient | undefined;

/** Typed API client for Client Components; sends the current Supabase access token and a correlation id. */
export function apiBrowser(): ApiClient {
  client ??= createApiClient({
    baseUrl: publicEnv.apiUrl,
    getToken: async () =>
      (await supabaseBrowser().auth.getSession()).data.session?.access_token ?? null,
    correlationId: mintCorrelationId,
  });
  return client;
}
