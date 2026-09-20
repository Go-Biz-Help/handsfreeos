/**
 * M17: what a customer is told before they tick the box.
 *
 * These assertions are not style preferences — each one is an element a 10DLC campaign review checks the
 * opt-in for, and a box that under-discloses is a registration that fails and a consent record that does not
 * hold up. The wording may change freely; what it has to keep saying may not.
 *
 * It is also the thing that keeps three screens in step. The public form, the booking page and the website
 * chat all ask for the same permission, and before this module the form said only "It's OK to text me about
 * this" — naming nobody, mentioning no cost, and offering no way out.
 */
import { describe, expect, it } from 'vitest';
import {
  HELP_KEYWORDS,
  STOP_KEYWORDS,
  optInDescriptionDefault,
  smsConsentWords,
  type ConsentPlace,
} from '../src/messaging/consent';

const PLACES: readonly ConsentPlace[] = ['form', 'booking', 'chat'];
const BUSINESS = 'Lone Star HVAC';

describe('every place we ask, we say the same six things', () => {
  it('names the business, because the business is the sender and we are not', () => {
    for (const place of PLACES) {
      const { title, detail } = smsConsentWords(BUSINESS, place);
      expect(`${title} ${detail}`).toContain(BUSINESS);
    }
  });

  it('says it is not a condition of buying anything', () => {
    for (const place of PLACES)
      expect(smsConsentWords(BUSINESS, place).detail).toMatch(/not a condition/i);
  });

  it('says how many messages varies, and that rates may apply', () => {
    for (const place of PLACES) {
      const { detail } = smsConsentWords(BUSINESS, place);
      expect(detail).toMatch(/varies/i);
      expect(detail).toMatch(/message and data rates may apply/i);
    }
  });

  it('offers the way out and the way to get help, in the words that actually work', () => {
    for (const place of PLACES) {
      const { detail } = smsConsentWords(BUSINESS, place);
      // STOP and HELP are what the code answers to (smsKeyword) and what the campaign declares. Telling a
      // customer to reply something else would be worse than telling them nothing.
      expect(detail).toContain(STOP_KEYWORDS[0]);
      expect(detail).toContain(HELP_KEYWORDS[0]);
    }
  });

  it('still reads like a sentence a person would read', () => {
    // Long enough to disclose, short enough that somebody actually reads it before ticking.
    for (const place of PLACES) {
      const { detail } = smsConsentWords(BUSINESS, place);
      expect(detail.length).toBeGreaterThan(120);
      expect(detail.length).toBeLessThan(400);
    }
  });

  it('falls back to something true when a business has no name on file', () => {
    const { title, detail } = smsConsentWords('   ', 'form');
    expect(`${title} ${detail}`).not.toContain('undefined');
    expect(detail).toMatch(/this business/);
  });
});

describe('what the carrier is told matches what the customer saw', () => {
  it('describes the tick box rather than a promise about one', () => {
    const description = optInDescriptionDefault(BUSINESS);
    expect(description).toContain(BUSINESS);
    for (const phrase of [/tick a box/i, /never ticked for them/i, /varies/i, /rates may apply/i])
      expect(description).toMatch(phrase);
    expect(description).toContain('STOP');
    expect(description).toContain('HELP');
  });

  it('is long enough for the registration to accept it', () => {
    // RegistrationSubmitInput asks for 40 characters and takes at most 1,000.
    const description = optInDescriptionDefault(BUSINESS);
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(1000);
  });
});
