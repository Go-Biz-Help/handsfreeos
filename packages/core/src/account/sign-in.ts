/**
 * Signing up and signing in, as the web and the phone both decide them: which "Continue with" buttons a screen shows,
 * and what a refused sign-up or provider sign-in says. Supabase Auth does the signing in; these only read its answers.
 */

/** Where a sign-in screen is: the web, or the phone app on an iPhone or an Android phone. */
export type SignInPlatform = 'web' | 'ios' | 'android';

/** The "Continue with" buttons a sign-in or sign-up screen shows. */
export interface SignInProviders {
  readonly google: boolean;
  readonly apple: boolean;
}

export const NO_SIGN_IN_PROVIDERS: SignInProviders = { google: false, apple: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Which buttons to show, from Supabase Auth's public settings (`GET /auth/v1/settings`, whose `external` says which
 * providers are on). A button only shows once its provider is turned on in the Supabase dashboard, so nobody presses
 * one that can't work; settings that can't be read show none, and email still works.
 *
 * Apple is the iPhone's alone: Sign in with Apple is built into the phone. On an iPhone, Google shows only beside
 * Apple, because Apple's review rules ask an app that offers another company's sign-in to offer Apple's too.
 */
export function signInProviders(settings: unknown, platform: SignInPlatform): SignInProviders {
  const external = isRecord(settings) && isRecord(settings.external) ? settings.external : {};
  const google = external.google === true;
  const apple = platform === 'ios' && external.apple === true;
  return { google: platform === 'ios' ? google && apple : google, apple };
}

/**
 * Whether Supabase's answer to a sign-up means the address already has an account. With email confirmation on it
 * doesn't refuse, so as not to tell strangers who has an account: it answers with a stand-in user that has no
 * identities, and sends nothing.
 */
export function isExistingAccount(
  user: { readonly identities?: readonly unknown[] | null } | null | undefined,
): boolean {
  return Array.isArray(user?.identities) && user.identities.length === 0;
}

export const EXISTING_ACCOUNT_MESSAGE = 'That email already has an account. Sign in instead.';

/** What creating an account says when Supabase Auth refuses it, by its error code. */
export function signUpMessage(code: string | null): string {
  switch (code) {
    case 'user_already_exists':
    case 'email_exists':
      return EXISTING_ACCOUNT_MESSAGE;
    case 'weak_password':
      return 'Choose a stronger password: at least 12 characters. A short sentence you’ll remember works well.';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Check the email address.';
    case 'over_email_send_rate_limit':
      return 'We couldn’t send the email just now. Wait a minute, then try again.';
    case 'email_address_not_authorized':
      return 'Our email can’t reach that address yet. Ask HandsFreeOS support.';
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a minute, then try again.';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'New accounts can’t be made right now. Try again later.';
    default:
      return 'Your account couldn’t be created. Try again.';
  }
}

export const PROVIDER_NAMES = { google: 'Google', apple: 'Apple' } as const;

/** What a "Continue with Google" or "Continue with Apple" that didn't finish says, by Supabase Auth's error code. */
export function providerSignInMessage(provider: 'google' | 'apple', code: string | null): string {
  switch (code) {
    case 'user_banned':
      return 'This account can’t sign in. Ask the business’s owner.';
    case 'provider_disabled':
    case 'oauth_provider_not_supported':
      return `Signing in with ${PROVIDER_NAMES[provider]} isn’t turned on yet. Use your email instead.`;
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a minute, then try again.';
    default:
      return `Signing in with ${PROVIDER_NAMES[provider]} didn’t finish. Try again, or use your email.`;
  }
}
