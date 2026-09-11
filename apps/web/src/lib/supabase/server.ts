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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The signed-in session, or null. Identity for display comes from the token's own claims rather than
 * the cookie's user object; every data access goes through the API, which verifies the token's
 * signature on each call.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const claims = decodeJwtPayload(token);
  const userId = typeof claims?.sub === 'string' ? claims.sub : null;
  if (!userId) return null;
  return { accessToken: token, userId, email: typeof claims?.email === 'string' ? claims.email : '' };
}
