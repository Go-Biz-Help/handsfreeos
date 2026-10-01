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
  checkTerms,
  checkWebsite,
  mentionsTexting,
  pageText,
  preflightBlocked,
  namesBusiness,
  promisesNotToShare,
  readConsentBox,
  showsConsentBox,
  type FetchedPage,
} from '../src/messaging/preflight';
import { smsConsentWords } from '../src/messaging/consent';
import {
  MOBILE_DATA_CLAUSE,
  policyAsText,
  privacyPolicy,
  termsOfService,
} from '../src/messaging/policies';

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

  it('warns, without blocking, when the business’s name is nowhere on it', () => {
    const check = checkWebsite(page(), ['Go Biz Help']);
    expect(check).toMatchObject({ ok: false, severity: 'warning' });
    expect(check.detail).toMatch(/Go Biz Help/);
    expect(checkWebsite(page(), ['Lone Star HVAC LLC']).ok).toBe(true);
  });

  it('finds a name however it is spaced, and by its first two words', () => {
    expect(namesBusiness('Welcome to GoBizHelp!', ['Go Biz Help'])).toBe(true);
    expect(namesBusiness('Lone Star HVAC fixes heating', ['Lone Star HVAC & Roofing'])).toBe(true);
    expect(namesBusiness('Somebody else entirely', ['Go Biz Help'])).toBe(false);
  });
});

describe('the terms', () => {
  it('passes the ones we write ourselves', () => {
    const html = `<html><body>${policyAsText(termsOfService({ name: 'Lone Star HVAC', phone: '(512) 555-0100' }))}</body></html>`;
    expect(checkTerms(page({ html })).ok).toBe(true);
  });

  it('warns about terms that never mention texting', () => {
    const check = checkTerms(page());
    expect(check).toMatchObject({ ok: false, severity: 'warning' });
  });

  it('blocks terms that do not open, or that were never given', () => {
    expect(checkTerms(page({ status: 404, html: '' }))).toMatchObject({
      ok: false,
      severity: 'blocker',
    });
    expect(checkTerms(null).ok).toBe(false);
  });

  it('says what our terms tell a customer about STOP, HELP and the carriers', () => {
    const text = policyAsText(
      termsOfService({ name: 'Lone Star HVAC', phone: '(512) 555-0100', offers: true }),
    );
    expect(text).toMatch(/Reply STOP at any time/);
    expect(text).toMatch(/call us at \(512\) 555-0100/);
    expect(text).toMatch(/not liable for delayed or undelivered/);
    expect(text).toMatch(/separate box/);
  });
});

describe('the page where customers agree', () => {
  /** The box as our own public form draws it: core's words, the privacy policy and the terms. */
  const words = smsConsentWords('Lone Star HVAC', 'form', '/legal/lone-star/privacy');
  const consentHtml = (box = '<input type="checkbox" id="c">', links = true) =>
    '<form><label>Your name <input type="text" required></label>' +
    `${box}<label for="c">${words.title}</label>` +
    `<p>${words.detail} ` +
    (links
      ? '<a href="/legal/lone-star/privacy">Privacy policy</a> · <a href="/legal/lone-star/terms">Terms</a>'
      : '') +
    '</p></form>';

  it('passes a page with the box and the wording on it', () => {
    expect(showsConsentBox(consentHtml())).toBe(true);
    expect(checkOptInSurface(page({ html: consentHtml() }), 'hosted', ['Lone Star HVAC']).ok).toBe(
      true,
    );
  });

  it('fails a page with the wording but no box to tick', () => {
    const html = '<p>Reply STOP to stop. Not a condition of buying anything.</p>';
    expect(showsConsentBox(html)).toBe(false);
    expect(checkOptInSurface(page({ html }), 'own_site').ok).toBe(false);
  });

  it('fails a page with a box but nothing said beside it', () => {
    expect(showsConsentBox('<input type="checkbox"><label>Sign up</label>')).toBe(false);
  });

  it('blocks a box that starts ticked, or that must be ticked to send the form', () => {
    const ticked = checkOptInSurface(
      page({ html: consentHtml('<input type="checkbox" id="c" checked>') }),
      'own_site',
    );
    expect(ticked).toMatchObject({ ok: false, severity: 'blocker' });
    expect(ticked.detail).toMatch(/already ticked/);
    const required = checkOptInSurface(
      page({ html: consentHtml('<input type="checkbox" id="c" required>') }),
      'own_site',
    );
    expect(required).toMatchObject({ ok: false, severity: 'blocker' });
    expect(required.detail).toMatch(/not required/);
  });

  it('names what is missing from beside the box', () => {
    const html =
      '<form><input type="checkbox" id="c"><label for="c">Text me</label>' +
      '<p>Reply STOP to stop.</p></form>';
    const check = checkOptInSurface(page({ html }), 'own_site', ['Lone Star HVAC']);
    expect(check).toMatchObject({ ok: false, severity: 'blocker' });
    for (const missing of [
      'business name',
      'HELP',
      'rates may apply',
      'how often',
      'privacy policy',
    ])
      expect(check.detail).toContain(missing);
  });

  it('only warns when the terms are not linked anywhere on the page', () => {
    const html = consentHtml('<input type="checkbox" id="c">', false).replace(
      '</p>',
      ' <a href="/privacy">Privacy policy</a></p>',
    );
    expect(checkOptInSurface(page({ html }), 'own_site')).toMatchObject({
      ok: false,
      severity: 'warning',
    });
  });

  it('reads the box beside the words about texting, not the other boxes on the form', () => {
    const services =
      '<p>Which services?</p>' +
      ['seo', 'ads', 'web']
        .map((v) => `<input type="checkbox" name="s" value="${v}" checked>`)
        .join('');
    const reading = readConsentBox(services + consentHtml(), ['Lone Star HVAC']);
    expect(reading).toMatchObject({ found: true, preTicked: false, required: false, missing: [] });
  });

  it('tells a hosted business to go back and press the button', () => {
    expect(checkOptInSurface(null, 'hosted').detail).toMatch(/Set this up for me/);
  });

  it('asks a business that takes permission in person for something to show', () => {
    const none = checkOptInSurface(null, 'in_person');
    expect(none).toMatchObject({ ok: false, severity: 'blocker' });
    const shown = checkOptInSurface(page({ html: '<img src="sheet.jpg">' }), 'in_person');
    expect(shown).toMatchObject({ ok: true, severity: 'warning' });
  });

  it('refuses proof that asks the reviewer to sign in', () => {
    const html =
      '<form><input type="email"><input type="password"></form><p>Sign in to continue</p>';
    const check = checkOptInSurface(page({ html }), 'in_person');
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/Anyone with the link/);
  });

  it('blocks a claimed page that does not load, whichever way it was set up', () => {
    for (const path of ['hosted', 'own_site', 'in_person'] as const) {
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
      preflightBlocked([checkWebsite(page()), checkWebsite(page(), ['Somebody Else Plumbing'])]),
    ).toBe(false);
  });
});
