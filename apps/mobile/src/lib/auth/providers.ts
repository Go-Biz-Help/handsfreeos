import {
  NO_SIGN_IN_PROVIDERS,
  signInProviders,
  type SignInPlatform,
  type SignInProviders,
} from '@hfos/core';
import * as React from 'react';
import { Platform } from 'react-native';

import { config } from '../config';
import { appFetch } from '../network';

const platform = (): SignInPlatform => (Platform.OS === 'ios' ? 'ios' : 'android');

let known: SignInProviders | null = null;
let asking: Promise<SignInProviders> | null = null;

/**
 * Which "Continue with" buttons the sign-in and sign-up screens show, from Supabase Auth's public settings: a provider
 * shows once it's turned on in the Supabase dashboard, with no new build (core's `signInProviders` has the rules).
 * The answer is kept while the app runs; without a signal there are none, and the next screen asks again.
 */
export function loadSignInProviders(fetchImpl: typeof fetch = appFetch): Promise<SignInProviders> {
  if (known) return Promise.resolve(known);
  asking ??= fetchImpl(`${config.supabaseUrl}/auth/v1/settings`, {
    headers: { apikey: config.supabasePublishableKey },
  })
    .then(async (res) => {
      if (!res.ok) return NO_SIGN_IN_PROVIDERS;
      known = signInProviders(await res.json(), platform());
      return known;
    })
    .catch(() => NO_SIGN_IN_PROVIDERS)
    .finally(() => {
      asking = null;
    });
  return asking;
}

/** Forgets the kept answer (tests). */
export function forgetSignInProviders(): void {
  known = null;
  asking = null;
}

export function useSignInProviders(): SignInProviders {
  const [providers, setProviders] = React.useState(known ?? NO_SIGN_IN_PROVIDERS);
  React.useEffect(() => {
    let live = true;
    void loadSignInProviders().then((found) => {
      if (live) setProviders(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return providers;
}
