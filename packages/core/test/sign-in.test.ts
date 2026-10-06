import { describe, expect, it } from 'vitest';
import {
  EXISTING_ACCOUNT_MESSAGE,
  isExistingAccount,
  NO_SIGN_IN_PROVIDERS,
  providerSignInMessage,
  signInProviders,
  signUpMessage,
} from '../src/account/sign-in';

/** Supabase Auth's `GET /auth/v1/settings`, trimmed to what matters here. */
const settings = (external: Record<string, boolean>) => ({
  external: { email: true, phone: false, ...external },
  disable_signup: false,
  mailer_autoconfirm: false,
});

describe('which Continue with buttons a screen shows', () => {
  it('shows Google on the web and on Android once it is turned on', () => {
    expect(signInProviders(settings({ google: true }), 'web')).toEqual({
      google: true,
      apple: false,
    });
    expect(signInProviders(settings({ google: true }), 'android')).toEqual({
      google: true,
      apple: false,
    });
    expect(signInProviders(settings({ google: false }), 'web')).toEqual(NO_SIGN_IN_PROVIDERS);
  });

  it('keeps Apple to the iPhone', () => {
    const both = settings({ google: true, apple: true });
    expect(signInProviders(both, 'ios')).toEqual({ google: true, apple: true });
    expect(signInProviders(both, 'web').apple).toBe(false);
    expect(signInProviders(both, 'android').apple).toBe(false);
  });

  it('shows Google on an iPhone only beside Apple', () => {
    expect(signInProviders(settings({ google: true, apple: false }), 'ios')).toEqual(
      NO_SIGN_IN_PROVIDERS,
    );
    expect(signInProviders(settings({ google: false, apple: true }), 'ios')).toEqual({
      google: false,
      apple: true,
    });
  });

  it('shows none when the settings can’t be read', () => {
    for (const unreadable of [null, undefined, 'offline', [], {}, { external: 'google' }])
      expect(signInProviders(unreadable, 'web')).toEqual(NO_SIGN_IN_PROVIDERS);
    expect(signInProviders({ external: { google: 'true' } }, 'web').google).toBe(false);
  });
});

describe('signing up', () => {
  it('tells an address that already has an account to sign in', () => {
    // With email confirmation on, Supabase answers with a stand-in user that has no identities.
    expect(isExistingAccount({ identities: [] })).toBe(true);
    expect(isExistingAccount({ identities: [{ provider: 'email' }] })).toBe(false);
    expect(isExistingAccount({ identities: null })).toBe(false);
    expect(isExistingAccount({})).toBe(false);
    expect(isExistingAccount(null)).toBe(false);
    expect(signUpMessage('user_already_exists')).toBe(EXISTING_ACCOUNT_MESSAGE);
    expect(EXISTING_ACCOUNT_MESSAGE).toMatch(/Sign in instead/);
  });

  it('says what to do about each refusal', () => {
    expect(signUpMessage('weak_password')).toMatch(/at least 12 characters/);
    expect(signUpMessage('email_address_invalid')).toBe('Check the email address.');
    expect(signUpMessage('over_email_send_rate_limit')).toMatch(/Wait a minute/);
    expect(signUpMessage('email_address_not_authorized')).toMatch(/Ask HandsFreeOS support/);
    expect(signUpMessage(null)).toMatch(/Try again/);
  });

  it('names the provider when Continue with Google or Apple doesn’t finish', () => {
    expect(providerSignInMessage('google', null)).toBe(
      'Signing in with Google didn’t finish. Try again, or use your email.',
    );
    expect(providerSignInMessage('apple', 'provider_disabled')).toMatch(
      /^Signing in with Apple isn’t turned on yet/,
    );
    expect(providerSignInMessage('google', 'user_banned')).toMatch(/Ask the business’s owner/);
  });
});
