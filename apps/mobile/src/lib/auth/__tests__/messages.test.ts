import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

import {
  isValidEmail,
  passwordMessage,
  sendCodeMessage,
  signUpErrorMessage,
  verifyCodeMessage,
} from '../messages';

const api = (status: number, code: string) => new AuthApiError('from Supabase Auth', status, code);

describe('sign-in messages', () => {
  it('checks the email address', () => {
    expect(isValidEmail('dale@lonestarhvac.test')).toBe(true);
    expect(isValidEmail(' dale@lonestarhvac.test ')).toBe(true);
    expect(isValidEmail('dale@lonestarhvac')).toBe(false);
    expect(isValidEmail('dale')).toBe(false);
  });

  it('says there’s no account, and to create one', () => {
    expect(sendCodeMessage(api(422, 'otp_disabled'))).toBe(
      'There’s no HandsFreeOS account for that email. Check it, or create an account.',
    );
  });

  it('says when there’s no signal', () => {
    const noSignal = new AuthRetryableFetchError('Network request failed', 0);
    for (const message of [
      sendCodeMessage(noSignal),
      verifyCodeMessage(noSignal),
      passwordMessage(noSignal),
      signUpErrorMessage(noSignal),
    ])
      expect(message).toBe('No signal. Try again when you’re back online.');
  });

  it('uses the web’s words for a wrong password', () => {
    expect(passwordMessage(api(400, 'invalid_credentials'))).toBe(
      'That email and password do not match. Try again, or email yourself a code.',
    );
    expect(passwordMessage(api(400, 'email_not_confirmed'))).toBe(
      'Confirm your email first, with the code we email you.',
    );
  });

  it('tells a sign-up that the email already has an account, in the web’s words', () => {
    expect(signUpErrorMessage(api(422, 'user_already_exists'))).toBe(
      'That email already has an account. Sign in instead.',
    );
    expect(signUpErrorMessage(api(422, 'weak_password'))).toMatch(/at least 12 characters/);
  });

  it('explains a wrong or old code, and too many codes', () => {
    expect(verifyCodeMessage(api(403, 'otp_expired'))).toMatch(/isn’t right, or it has expired/);
    expect(sendCodeMessage(api(429, 'over_email_send_rate_limit'))).toMatch(/Wait a minute/);
  });
});
