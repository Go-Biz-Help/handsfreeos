/**
 * M17: what counts as a domain a business may put its pages on.
 *
 * The shape check runs twice on purpose — here in Zod so somebody typing gets a sentence they can act on,
 * and again in a check constraint on `app.branded_domains` so nothing else can write a name past it.
 *
 * **Whose the name is, is a separate question, and it is not asked here.** 0090 moved it: whether one of
 * our own names may be claimed depends on which workspace is asking, so the handler asks the database and
 * a trigger refuses anything that gets past it (`packages/db/test/branded-domain-rls.test.ts`). What Zod
 * still owes us is `isOurHost` — recognising one of ours, however it is written, so the handler knows to
 * ask at all.
 */
import { describe, expect, it } from 'vitest';
import { hostname, isOurHost } from '../src/schemas/branded-domain';

const ok = (s: string) => hostname.safeParse(s);

describe('a branded domain name', () => {
  it('takes the ordinary shape, and tidies it on the way in', () => {
    expect(ok('booking.lonestarhvac.com').data).toBe('booking.lonestarhvac.com');
    expect(ok('  Booking.LoneStarHVAC.com  ').data).toBe('booking.lonestarhvac.com');
    expect(ok('lonestar-hvac.co.uk').data).toBe('lonestar-hvac.co.uk');
    expect(ok('book.lonestarhvac.plumbing').data).toBe('book.lonestarhvac.plumbing');
  });

  it('knows one of ours, however it is written', () => {
    for (const d of [
      'handsfreeos.com',
      'app.handsfreeos.com',
      'BOOK.HandsFreeOS.com',
      '  link.handsfreeos.com  ',
    ])
      expect(isOurHost(d), d).toBe(true);
  });

  it('does not mistake somebody else’s name for one of ours', () => {
    // The trailing-label match matters: `handsfreeos.com.evil.test` ends in neither, and
    // `nothandsfreeos.com` only looks like it does.
    for (const d of [
      'booking.lonestarhvac.com',
      'nothandsfreeos.com',
      'handsfreeos.com.evil.test',
      'handsfreeos.co',
    ])
      expect(isOurHost(d), d).toBe(false);
  });

  it('leaves whose-name-is-it to the handler, so the shape check takes one of ours', () => {
    // Not an endorsement — `link.handsfreeos.com` is the right shape, and `branded_domain.add` is what
    // decides whether this workspace may have it.
    expect(ok('link.handsfreeos.com').success).toBe(true);
  });

  it('refuses a name with a scheme or a path on it, which is what somebody pastes', () => {
    for (const d of [
      'https://booking.lonestarhvac.com',
      'booking.lonestarhvac.com/book',
      'booking.lonestarhvac.com:443',
    ])
      expect(ok(d).success, d).toBe(false);
  });

  it('says something a person can act on rather than naming a regular expression', () => {
    const issue = ok('https://booking.lonestarhvac.com').error?.issues[0]?.message ?? '';
    expect(issue).toMatch(/go\.yourbusiness\.com/);
    expect(issue).toMatch(/no https/i);
  });

  it('refuses what is not a domain at all', () => {
    for (const d of ['', 'lonestar', 'lonestar.', '.com', '-lonestar.com', 'lone_star.com', 'a.b'])
      expect(ok(d).success, d).toBe(false);
  });

  it('refuses a label longer than DNS allows, and a name longer than DNS allows', () => {
    // 64 characters in one label: one past the limit.
    expect(ok(`${'a'.repeat(64)}.com`).success).toBe(false);
    // Legal labels, too many of them: 5 × 60 + separators is past 253.
    const long = Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.');
    expect(ok(`${long}.com`).success).toBe(false);
  });
});
