/**
 * What the reviewer finds when they go looking.
 *
 * These are the three failures that cost a business a week each, so the assertions are about meaning and
 * not about our own wording: a policy a lawyer wrote says "we never sell your mobile number to anyone" and
 * a reviewer reading for sense would accept it, so we do too. What may not pass is a page that answers a
 * different question — "we will not share your information", with nothing about texting anywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  checkOptInSurface,
  checkPolicy,
  checkWebsite,
  mentionsTexting,
  pageText,
  preflightBlocked,
  promisesNotToShare,
  showsConsentBox,
  type FetchedPage,
} from '../src/messaging/preflight';
import { MOBILE_DATA_CLAUSE, policyAsText, privacyPolicy } from '../src/messaging/policies';

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
  url: 'https://lonestarhvac.test',
  status: 200,
  html: '<html><body>' + 'Lone Star HVAC fits and fixes heating. '.repeat(20) + '</body></html>',
  ...over,
});

describe('reading a page', () => {
  it('drops scripts and markup rather than matching inside them', () => {
    const text = pageText('<script>var reply = "STOP";</script><p>Hello&nbsp;there</p>');
    expect(text).toBe('hello there');
  });

  it('treats curly quotes as ordinary ones', () => {
    expect(pageText('<p>We’ll never sell it</p>')).toContain("we'll never sell it");
  });
});

describe('the privacy policy', () => {
  it('passes the one we generate ourselves', () => {
    const html = `<html><body>${policyAsText(privacyPolicy({ name: 'Lone Star HVAC' }))}</body></html>`;
    const check = checkPolicy(page({ html }));
    expect(check.ok).toBe(true);
  });

  it('passes a policy that promises the same thing in its own words', () => {
    const text =
      'Privacy. We never sell or share your mobile phone number with anyone. Text messages you receive from us are about your appointments.';
    expect(promisesNotToShare(pageText(text))).toBe(true);
    expect(checkPolicy(page({ html: text })).ok).toBe(true);
  });

  it('fails a policy that never mentions texting, however much it promises', () => {
    const text =
      'Privacy. We will never share or sell your personal information to any third party for any reason whatsoever.';
    expect(mentionsTexting(pageText(text))).toBe(false);
    const check = checkPolicy(page({ html: text }));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/never mentions text messages/i);
  });

  it('fails a policy that mentions texting but promises nothing', () => {
    const text = 'We may send you text messages about your appointments. Reply STOP to stop.';
    const check = checkPolicy(page({ html: text }));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/not say phone numbers are never shared/i);
  });

  it('fails a policy that does not load, and says the reviewer will see the same', () => {
    const check = checkPolicy(page({ status: 404, html: '' }));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/404/);
  });

  it('fails when there is no policy at all', () => {
    expect(checkPolicy(null).ok).toBe(false);
  });

  it('recognises our own clause verbatim', () => {
    expect(promisesNotToShare(pageText(MOBILE_DATA_CLAUSE))).toBe(true);
  });
});

describe('the website', () => {
  it('passes a page with something on it', () => {
    expect(checkWebsite(page()).ok).toBe(true);
  });

  it('fails a page that will not open', () => {
    expect(checkWebsite(page({ status: null, error: 'dns' })).ok).toBe(false);
  });

  it('fails a page that opens onto almost nothing', () => {
    const check = checkWebsite(page({ html: '<html><body>Coming soon</body></html>' }));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/almost nothing/i);
  });

  it('fails when no website was given', () => {
    expect(checkWebsite(null).ok).toBe(false);
  });
});

describe('the page where customers agree', () => {
  const consentHtml =
    '<form><input type="checkbox" id="c"><label for="c">Text me, Lone Star HVAC</label>' +
    '<p>Agreeing is not a condition of buying anything. Reply STOP to stop.</p></form>';

  it('passes a page with the box and the wording on it', () => {
    expect(showsConsentBox(consentHtml)).toBe(true);
    expect(checkOptInSurface(page({ html: consentHtml }), 'hosted').ok).toBe(true);
  });

  it('fails a page with the wording but no box to tick', () => {
    const html = '<p>Reply STOP to stop. Not a condition of buying anything.</p>';
    expect(showsConsentBox(html)).toBe(false);
    expect(checkOptInSurface(page({ html }), 'own_site').ok).toBe(false);
  });

  it('fails a page with a box but nothing said beside it', () => {
    expect(showsConsentBox('<input type="checkbox"><label>Sign up</label>')).toBe(false);
  });

  it('tells a hosted business to go back and press the button', () => {
    expect(checkOptInSurface(null, 'hosted').detail).toMatch(/Set this up for me/);
  });

  it('does not block a business that takes permission in person', () => {
    const check = checkOptInSurface(null, 'in_person');
    expect(check.severity).toBe('warning');
    expect(check.ok).toBe(true);
  });

  it('blocks a claimed page that does not load, whichever way it was set up', () => {
    for (const path of ['hosted', 'own_site'] as const) {
      const check = checkOptInSurface(page({ status: 500, html: '' }), path);
      expect(check.severity).toBe('blocker');
      expect(check.ok).toBe(false);
    }
  });
});

describe('what stops a submit', () => {
  it('is any failed blocker, and never a failed warning', () => {
    expect(preflightBlocked([checkWebsite(null)])).toBe(true);
    expect(
      preflightBlocked([
        checkWebsite(page()),
        { ...checkOptInSurface(null, 'in_person'), ok: false },
      ]),
    ).toBe(false);
  });
});
