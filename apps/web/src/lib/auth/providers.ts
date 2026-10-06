import { NO_SIGN_IN_PROVIDERS, signInProviders, type SignInProviders } from '@hfos/core';
import { publicEnv } from '../env';

/**
 * The "Continue with" buttons the sign-in and sign-up pages show, read on the server from Supabase Auth's public
 * settings. A provider turned on in the Supabase dashboard shows within a minute, with no deploy; settings that can't
 * be read show none, and email still works.
 */
export async function webSignInProviders(): Promise<SignInProviders> {
  try {
    const res = await fetch(`${publicEnv.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: publicEnv.supabasePublishableKey },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return NO_SIGN_IN_PROVIDERS;
    return signInProviders(await res.json(), 'web');
  } catch {
    return NO_SIGN_IN_PROVIDERS;
  }
}
