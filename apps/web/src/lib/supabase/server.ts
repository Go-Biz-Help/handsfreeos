import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { publicEnv } from '../env';

/** Server Supabase client bound to the request cookies. Server Components cannot write cookies; the proxy refreshes them. */
export async function supabaseServer(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          /* called from a Server Component: the proxy already refreshed the session */
        }
      },
    },
  });
}

export interface ServerSession {
  readonly accessToken: string;
  readonly userId: string;
  readonly email: string;
}

/** The signed-in session, or null. The token is verified by the API on every call. */
export async function getServerSession(): Promise<ServerSession | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s?.access_token || !s.user?.id) return null;
  return { accessToken: s.access_token, userId: s.user.id, email: s.user.email ?? '' };
}
