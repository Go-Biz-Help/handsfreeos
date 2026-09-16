import type { SupabaseClient } from '@supabase/supabase-js';

import { config } from './config';

/**
 * Signing in with a passkey: Supabase's two steps with the phone's own passkey sheet between them. supabase-js's
 * one-call `signInWithPasskey` needs a browser, so the phone asks for the challenge, hands it to the operating system,
 * and sends back what the person's passkey signed.
 *
 * Hidden until it can work. Still to come before `EXPO_PUBLIC_PASSKEYS_ENABLED=true`:
 * - a native passkey module (react-native-passkeys or react-native-passkey) registered with `setPlatformPasskeys`;
 * - handsfreeos.com live, serving `webcredentials` for the app in apple-app-site-association and
 *   `get_login_creds` in assetlinks.json;
 * - Supabase's passkey settings with `handsfreeos.com` as the relying party and the Android app's
 *   `android:apk-key-hash:` origin (from Google Play's signing key) among the allowed origins.
 */

/** The operating system's passkey sheet: takes the request options, returns the signed credential (as JSON). */
export interface PlatformPasskeys {
  get(requestOptions: unknown): Promise<unknown>;
}

let platform: PlatformPasskeys | null = null;

export function setPlatformPasskeys(impl: PlatformPasskeys | null): void {
  platform = impl;
}

export function passkeysAvailable(): boolean {
  return config.passkeysEnabled && platform !== null;
}

export type PasskeyResult =
  | { readonly outcome: 'signedIn' }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'failed'; readonly message: string };

const CANCELLED = /cancel|abort|not ?allowed/i;

export async function signInWithPasskey(
  client: SupabaseClient,
  passkeys: PlatformPasskeys | null = platform,
): Promise<PasskeyResult> {
  if (!passkeys) return { outcome: 'failed', message: 'Passkeys aren’t set up on this phone yet.' };
  const start = await client.auth.passkey.startAuthentication();
  if (start.error || !start.data)
    return { outcome: 'failed', message: 'Couldn’t start signing in with a passkey. Try again.' };
  let credential: unknown;
  try {
    credential = await passkeys.get(start.data.options);
  } catch (error) {
    return error instanceof Error && CANCELLED.test(error.message)
      ? { outcome: 'cancelled' }
      : {
          outcome: 'failed',
          message: 'That passkey didn’t work. Try again, or email yourself a code.',
        };
  }
  const verified = await client.auth.passkey.verifyAuthentication({
    challengeId: start.data.challenge_id,
    credential: credential as Parameters<
      SupabaseClient['auth']['passkey']['verifyAuthentication']
    >[0]['credential'],
  });
  if (verified.error || !verified.data?.session)
    return {
      outcome: 'failed',
      message: 'That passkey didn’t work. Try again, or email yourself a code.',
    };
  return { outcome: 'signedIn' };
}
