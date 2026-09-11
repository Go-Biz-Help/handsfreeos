import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicEnv } from '../env';

let client: SupabaseClient | undefined;

/** Browser Supabase client (auth only; data always goes through the HandsFreeOS API). */
export function supabaseBrowser(): SupabaseClient {
  client ??= createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
    auth: { experimental: { passkey: true } },
  });
  return client;
}
