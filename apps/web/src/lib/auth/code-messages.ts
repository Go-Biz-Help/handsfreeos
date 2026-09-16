import { isAuthApiError, isAuthRetryableFetchError } from '@supabase/supabase-js';

/**
 * What the sign-in page says when Supabase Auth refuses an emailed code, in the phone app's words
 * (apps/mobile/src/lib/auth/messages.ts) where the web has none of its own. New accounts start on the web, so an
 * unknown address points at Create an account.
 */

/** How long before another code can be sent (Supabase Auth's own limit on the hosted project). */
export const RESEND_SECONDS = 60;
export const CODE_LENGTH = 6;

function codeOf(error: unknown): string | null {
  return isAuthApiError(error) && typeof error.code === 'string' ? error.code : null;
}

const NO_CONNECTION = 'HandsFreeOS couldn’t be reached. Check your connection and try again.';

/** Email me a code. */
export function sendCodeMessage(error: unknown): string {
  if (isAuthRetryableFetchError(error)) return NO_CONNECTION;
  switch (codeOf(error)) {
    case 'otp_disabled':
    case 'signup_disabled':
    case 'user_not_found':
      return 'There’s no HandsFreeOS account for that email. Check it, or create an account.';
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
  if (isAuthRetryableFetchError(error)) return NO_CONNECTION;
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

/** "0:42" */
export function countdown(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
