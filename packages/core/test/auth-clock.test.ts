/**
 * A computer whose clock is wrong (`auth/clock`): the web app judges a sign-in's time left by the server's clock, so a
 * clock an hour fast no longer renews the sign-in on every request until Supabase refuses one and it's dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  clockOffsetMs,
  clockOffWords,
  SIGN_IN_RENEW_BEFORE_MS,
  signInIssuedAt,
  signInTimeLeftMs,
} from '../src/auth/clock';

const tokenWith = (claims: Record<string, unknown>) =>
  [
    Buffer.from('{"alg":"ES256"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.');

describe('a computer whose clock is wrong', () => {
  it('reads when a sign-in was issued, and nothing from a token it can’t read', () => {
    expect(signInIssuedAt(tokenWith({ iat: 1_794_000_000, sub: 'x' }))).toBe(1_794_000_000);
    // base64url's own letters, which plain base64 doesn't use.
    expect(signInIssuedAt(tokenWith({ iat: 1_794_000_000, note: '>>>???' }))).toBe(1_794_000_000);
    expect(signInIssuedAt('not a token')).toBeNull();
    expect(signInIssuedAt(tokenWith({ sub: 'x' }))).toBeNull();
    expect(signInIssuedAt('a.%%%.b')).toBeNull();
  });

  it('keeps using a sign-in an hour fast clock calls spent, and renews it near its real end', () => {
    const issuedAt = 1_794_000_000; // server time, seconds
    const expiresAt = issuedAt + 3600;
    const hourFast = 3_600_000;
    // Renewed a moment ago: the computer says it's an hour later than the server does.
    const now = issuedAt * 1000 + hourFast + 1500;
    const offset = clockOffsetMs(issuedAt, now);
    expect(offset).toBe(hourFast + 1500);
    // By the computer's clock the sign-in is spent; by the server's it has nearly an hour left.
    expect(expiresAt * 1000 - now).toBeLessThan(SIGN_IN_RENEW_BEFORE_MS);
    // (The renewal's own trip, 1.5 seconds here, counts as clock: far inside the minute it's renewed early.)
    expect(signInTimeLeftMs(expiresAt, now, offset)).toBe(3600 * 1000);
    // 59 and a half minutes on, it's renewed.
    expect(signInTimeLeftMs(expiresAt, now + 3_570_000, offset)).toBeLessThan(
      SIGN_IN_RENEW_BEFORE_MS,
    );
    // A right clock is judged as it always was.
    expect(signInTimeLeftMs(expiresAt, issuedAt * 1000 + 600_000, 0)).toBe(3_000_000);
  });

  it('says how far the clock is off once it’s worth saying', () => {
    expect(clockOffWords(0)).toBeNull();
    expect(clockOffWords(90_000)).toBeNull();
    expect(clockOffWords(-90_000)).toBeNull();
    expect(clockOffWords(3_601_500)).toMatch(/^Your computer’s clock is about an hour fast/);
    expect(clockOffWords(3_601_500)).toContain('Set time automatically');
    expect(clockOffWords(-10 * 60_000)).toMatch(/about 10 minutes slow/);
    expect(clockOffWords(3 * 3_600_000)).toMatch(/about 3 hours fast/);
    expect(clockOffWords(-2 * 86_400_000)).toMatch(/about 2 days slow/);
  });
});
