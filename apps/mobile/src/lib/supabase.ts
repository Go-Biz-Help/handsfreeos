import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { withRefreshGuard } from './auth/refresh-fetch';
import { config } from './config';
import { appFetch } from './network';
import { SESSION_KEY, secureSessionStorage } from './secure-storage';

/**
 * The one Supabase client, used for signing in and keeping the sign-in fresh (the app reads and writes business data
 * through the API, never Supabase directly). The session lives in secure storage; `session.ts` starts and stops the
 * refresh timer as the app comes and goes, since supabase-js can't tell when a phone app is in the foreground.
 *
 * PKCE, as on the web: Continue with Google comes back to the app's own address with a one-time code that only this
 * app, holding the verifier it kept, can swap for a sign-in (another app answering to `handsfreeos://` gets nothing).
 * Emailed codes work the same either way.
 */
export function createSupabase(fetchImpl: typeof fetch = appFetch): SupabaseClient {
  return createClient(
    config.supabaseUrl || 'http://localhost',
    config.supabasePublishableKey || 'unset',
    {
      auth: {
        storage: secureSessionStorage,
        storageKey: SESSION_KEY,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
        experimental: { passkey: config.passkeysEnabled },
      },
      global: { fetch: withRefreshGuard(fetchImpl) },
    },
  );
}

export const supabase = createSupabase();
