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
  callConsentWords,
  offersConsentWords,
  optInDescriptionDefault,
  optInDescriptionFor,
  ownSiteBoxText,
  sendsOffers,
  smsConsentWords,
  type ConsentPlace,
} from '../src/messaging/consent';
import { keywordReplies, TWILIO_STOP_REPLY } from '../src/messaging/sms';

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

describe('the terms are linked beside the policy', () => {
  it('gives back both links, so the page renders both', () => {
    const words = smsConsentWords('Lone Star HVAC', 'form', '/legal/x/privacy', '/legal/x/terms');
    expect(words).toMatchObject({ policyUrl: '/legal/x/privacy', termsUrl: '/legal/x/terms' });
    expect(smsConsentWords('Lone Star HVAC', 'form').termsUrl).toBeNull();
  });
});

describe('offers have a box of their own', () => {
  it('only for a business whose texts include offers', () => {
    expect(sendsOffers('mixed')).toBe(true);
    expect(sendsOffers('marketing')).toBe(true);
    expect(sendsOffers('customer_care')).toBe(false);
  });

  it('names the business, says it is separate and optional, and keeps the disclosures', () => {
    const words = offersConsentWords('Lone Star HVAC');
    expect(words.title).toContain('Lone Star HVAC');
    expect(words.detail).toMatch(/separate/);
    expect(words.detail).toMatch(/never required/);
    expect(words.detail).toMatch(/rates may apply/);
    expect(words.detail).toMatch(/Reply STOP/);
  });

  it('gives a business with its own site the same words to copy, with the offers box when it sends offers', () => {
    const care = ownSiteBoxText('Lone Star HVAC', false);
    expect(care).toContain(smsConsentWords('Lone Star HVAC', 'form').detail);
    expect(care).not.toMatch(/offers/i);
    expect(ownSiteBoxText('Lone Star HVAC', true)).toContain(
      offersConsentWords('Lone Star HVAC').title,
    );
  });
});

describe('calls have a box of their own', () => {
  // What a written yes to AI calls has to say, for the owner's lawyer: who calls, that it may be an AI or a
  // recorded voice, what about, that it isn't a condition of buying, that calls may be recorded, and how to stop.
  const { title, detail } = callConsentWords(BUSINESS);

  it('says it may be an AI, and names the business that calls rather than us', () => {
    expect(title).toMatch(/OK to call/i);
    expect(`${title} ${detail}`).toMatch(/AI assistant/i);
    expect(detail).toMatch(/recorded voice/i);
    expect(detail).toContain(BUSINESS);
    expect(`${title} ${detail}`).not.toMatch(/HandsFreeOS/i);
  });

  it('says what about, that it isn’t a condition of buying, that calls may be recorded, and how to stop', () => {
    expect(detail).toMatch(/services and offers/i);
    expect(detail).toMatch(/not a condition/i);
    expect(detail).toMatch(/may be recorded/i);
    expect(detail).toMatch(/stop/i);
  });

  it('falls back to something true when a business has no name on file', () => {
    expect(callConsentWords('  ').detail).toMatch(/^this business may call/);
  });
});

describe('the description names the pages a reviewer can open', () => {
  it('points at the business’s own page with the box', () => {
    const text = optInDescriptionFor(
      'Go Biz Help',
      'own_site',
      {},
      {
        pageUrl: 'https://www.gobizhelp.com/contact',
      },
    );
    expect(text).toContain('at https://www.gobizhelp.com/contact');
    expect(text).toMatch(/links to the privacy policy and the terms/);
  });

  it('says offers have their own box, and where proof of in-person agreement is', () => {
    expect(optInDescriptionFor('Go Biz Help', 'hosted', {}, { offers: true })).toMatch(
      /second, separate box/,
    );
    expect(
      optInDescriptionFor('Go Biz Help', 'in_person', {}, { proofUrl: 'https://drive.test/sheet' }),
    ).toContain('https://drive.test/sheet');
  });

  it('says the chat on their own site asks after the first message, and where a reviewer sees it', () => {
    const text = optInDescriptionFor('Lone Star HVAC', 'hosted', {
      siteUrl: 'https://lonestarhvac.com',
      chatUrl: 'https://app.handsfreeos.com/chat/wk_AbCdEfGhIjKlMnOpQrSt',
    });
    expect(text).toContain('in the chat on https://lonestarhvac.com');
    expect(text).toMatch(/after a visitor sends their first message/i);
    expect(text).toMatch(/name, mobile number and email/);
    expect(text).toContain(
      'A page showing exactly what the chat asks is at https://app.handsfreeos.com/chat/wk_AbCdEfGhIjKlMnOpQrSt.',
    );
    expect(text).toMatch(/links to the privacy policy and the terms/);
    // A form already carrying the box is said too; nothing claims one that isn't there.
    expect(text).not.toMatch(/\/f\//);
    expect(
      optInDescriptionFor('Lone Star HVAC', 'hosted', {
        siteUrl: 'https://lonestarhvac.com',
        formUrl: 'https://app.handsfreeos.com/f/lone-star/contact-us',
      }),
    ).toContain('The same box is on https://app.handsfreeos.com/f/lone-star/contact-us.');
  });

  it('stays under what the registration accepts', () => {
    const urls = {
      formUrl: 'https://app.handsfreeos.com/f/lone-star-hvac-and-roofing/contact-us',
      bookingUrl: 'https://app.handsfreeos.com/book/lone-star-hvac-and-roofing',
      chatUrl: 'https://app.handsfreeos.com/chat/cw_abcdefghijklmnopqrstuvwx',
      siteUrl: 'https://www.lonestarhvacandroofing.com',
    };
    const text = optInDescriptionFor('Lone Star HVAC & Roofing', 'hosted', urls, { offers: true });
    expect(text.length).toBeLessThanOrEqual(1500);
  });
});

describe('what STOP and HELP get back', () => {
  it('declares Twilio’s own STOP reply, because that is the one customers get', () => {
    expect(keywordReplies('Lone Star HVAC', '(512) 555-0100').stop).toBe(TWILIO_STOP_REPLY);
  });

  it('answers HELP with the business’s name and a number to reach it', () => {
    const help = keywordReplies('Lone Star HVAC', '(512) 555-0100').help;
    expect(help).toMatch(/^Lone Star HVAC:/);
    expect(help).toContain('(512) 555-0100');
    expect(help).toMatch(/Reply STOP/);
    expect(help.length).toBeLessThanOrEqual(160);
  });
});
