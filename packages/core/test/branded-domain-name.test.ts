/**
 * M17: what counts as a domain a business may put its pages on.
 *
 * The check runs twice on purpose — here in Zod so somebody typing gets a sentence they can act on, and
 * again in a check constraint on `app.branded_domains` so nothing else can write a name past it. This
 * covers the first of those, and the cases that matter are the refusals: one of our own names accepted here
 * would let a business point `handsfreeos.com` at itself and take the app down for everybody.
 */
import { describe, expect, it } from 'vitest';
import { hostname } from '../src/schemas/branded-domain';

const ok = (s: string) => hostname.safeParse(s);

describe('a branded domain name', () => {
  it('takes the ordinary shape, and tidies it on the way in', () => {
    expect(ok('booking.lonestarhvac.com').data).toBe('booking.lonestarhvac.com');
    expect(ok('  Booking.LoneStarHVAC.com  ').data).toBe('booking.lonestarhvac.com');
    expect(ok('lonestar-hvac.co.uk').data).toBe('lonestar-hvac.co.uk');
    expect(ok('book.lonestarhvac.plumbing').data).toBe('book.lonestarhvac.plumbing');
  });

  it('refuses one of ours, however it is written', () => {
    for (const d of ['handsfreeos.com', 'app.handsfreeos.com', 'BOOK.HandsFreeOS.com'])
      expect(ok(d).success, d).toBe(false);
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
    expect(issue).toMatch(/booking\.yourbusiness\.com/);
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
