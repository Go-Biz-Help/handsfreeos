import { providerSignInMessage } from '@hfos/core';
import { isAuthError, type SupabaseClient } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import { APP_SCHEME } from '@/links/route-map';

import { NO_SIGNAL, isNoSignal } from './messages';

/**
 * Continue with Google and Continue with Apple on the phone. Google opens Google's own page in the phone's sign-in
 * browser (never a web view), and Supabase sends the phone back to the app's own address with a one-time code the app
 * swaps for the sign-in; the client is PKCE, so only this app can swap it. Apple is the iPhone's own sheet, and its
 * signed answer goes straight to Supabase. Either one makes the account the first time.
 */

/** Where Supabase sends the phone back after Continue with Google. It must be in Supabase's Redirect URLs. */
export const AUTH_RETURN = `${APP_SCHEME}://auth/callback`;

export type ProviderOutcome =
  | { readonly outcome: 'signedIn'; readonly name?: string }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'failed'; readonly message: string };

/** The query and fragment of an address, read by hand: React Native's URL can't read search params. */
function paramsOf(url: string): Map<string, string> {
  const found = new Map<string, string>();
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const query = beforeHash.includes('?') ? beforeHash.slice(beforeHash.indexOf('?') + 1) : '';
  const fragment = hashAt < 0 ? '' : url.slice(hashAt + 1);
  for (const part of [query, fragment])
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const decode = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      const key = decode(eq < 0 ? pair : pair.slice(0, eq));
      if (!found.has(key)) found.set(key, eq < 0 ? '' : decode(pair.slice(eq + 1)));
    }
  return found;
}

/**
 * What Supabase sent the phone back with: the code to swap for a sign-in, or why not. A banned account (one that was
 * deleted) comes back as `user_banned`, whichever way Supabase words it.
 */
export function readAuthReturn(url: string): { code: string } | { refused: string | null } {
  const params = paramsOf(url);
  const code = params.get('code');
  if (code) return { code };
  const said = `${params.get('error_code') ?? ''} ${params.get('error_description') ?? ''}`;
  if (/banned/i.test(said)) return { refused: 'user_banned' };
  return { refused: params.get('error_code') || params.get('error') || null };
}

function failed(provider: 'google' | 'apple', error: unknown): ProviderOutcome {
  if (isNoSignal(error)) return { outcome: 'failed', message: NO_SIGNAL };
  const code = isAuthError(error) && typeof error.code === 'string' ? error.code : null;
  return { outcome: 'failed', message: providerSignInMessage(provider, code) };
}

export async function continueWithGoogle(supabase: SupabaseClient): Promise<ProviderOutcome> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: AUTH_RETURN, skipBrowserRedirect: true },
  });
  if (error || !data.url) return failed('google', error);
  const result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_RETURN);
  if (result.type !== 'success') return { outcome: 'cancelled' };
  const back = readAuthReturn(result.url);
  if (!('code' in back))
    return { outcome: 'failed', message: providerSignInMessage('google', back.refused) };
  const swapped = await supabase.auth.exchangeCodeForSession(back.code);
  if (swapped.error) return failed('google', swapped.error);
  return { outcome: 'signedIn' };
}

/** "Chris Martinez", from the name Apple shares the first time only. */
export function nameFromApple(
  name: AppleAuthentication.AppleAuthenticationFullName | null,
): string {
  return [name?.givenName, name?.familyName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Sign in with Apple. The nonce goes to Apple hashed and to Supabase as it is, so Supabase knows Apple's answer was
 * made for this sign-in. Apple shares the person's name only the first time, so it comes back with the outcome for the
 * account to keep.
 */
export async function continueWithApple(supabase: SupabaseClient): Promise<ProviderOutcome> {
  const nonce = Crypto.randomUUID();
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce),
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return { outcome: 'cancelled' };
    return { outcome: 'failed', message: providerSignInMessage('apple', null) };
  }
  if (!credential.identityToken)
    return { outcome: 'failed', message: providerSignInMessage('apple', null) };
  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce,
  });
  if (error) return failed('apple', error);
  const name = nameFromApple(credential.fullName);
  return name ? { outcome: 'signedIn', name } : { outcome: 'signedIn' };
}
