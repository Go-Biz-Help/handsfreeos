import { isAuthError, isAuthRetryableFetchError } from '@supabase/supabase-js';

/** What the sign-in screens say when Supabase Auth says no, in the web's words where the web has them. */

export const NO_SIGNAL = 'No signal. Try again when you’re back online.';

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function codeOf(error: unknown): string | null {
  return isAuthError(error) && typeof error.code === 'string' ? error.code : null;
}

function isNoSignal(error: unknown): boolean {
  return isAuthRetryableFetchError(error) || error instanceof TypeError;
}

/** Email me a code. */
export function sendCodeMessage(error: unknown): string {
  if (isNoSignal(error)) return NO_SIGNAL;
  switch (codeOf(error)) {
    case 'otp_disabled':
    case 'signup_disabled':
    case 'user_not_found':
      return 'There’s no HandsFreeOS account for that email. New accounts start on the web.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'A code was sent a moment ago. Wait a minute, then send another.';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Check the email address.';
    case 'user_banned':
      return 'This account can’t sign in. Ask the business’s owner.';
    default:
      return 'The code couldn’t be sent. Try again.';
  }
}

/** The 6-digit code. */
export function verifyCodeMessage(error: unknown): string {
  if (isNoSignal(error)) return NO_SIGNAL;
  switch (codeOf(error)) {
    case 'otp_expired':
      return 'That code isn’t right, or it has expired. Check the email, or send another code.';
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a minute, then try again.';
    case 'user_banned':
      return 'This account can’t sign in. Ask the business’s owner.';
    default:
      return 'That code didn’t work. Send another code and try again.';
  }
}

/** The password. */
export function passwordMessage(error: unknown): string {
  if (isNoSignal(error)) return NO_SIGNAL;
  switch (codeOf(error)) {
    case 'invalid_credentials':
      return 'That email and password do not match. Try again, or email yourself a code.';
    case 'email_not_confirmed':
      return 'Confirm your email first. Check your inbox for the link.';
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a minute, then try again.';
    case 'user_banned':
      return 'This account can’t sign in. Ask the business’s owner.';
    default:
      return 'Signing in didn’t work. Try again.';
  }
}
