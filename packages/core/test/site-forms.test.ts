/**
 * Every form on the site, read the way a carrier's reviewer reads them (owner, 2026-11-18).
 *
 * The fixtures are cut down from what Shop Your Solar's site really served when its campaign was turned down for
 * "forced consent" (Twilio 30923): a HighLevel form framed on /instant-quote with two texting boxes the form marks
 * required, one for marketing, and GoDaddy's Create Account page asking for a phone number under a line about
 * newsletters. Neither page was in the registration.
 */
import { describe, expect, it } from 'vitest';
import { smsConsentWords } from '../src/messaging/consent';
import {
  checkSiteForms,
  formsOn,
  pageKey,
  shortAddress,
  siteFormsFound,
  siteFormsSummary,
  type SiteForm,
  type SiteScan,
} from '../src/messaging/site-forms';

const SITE = 'https://shopyoursolar.com';

/** HighLevel's form builder: a "terms and conditions" field holding two boxes, both marked required. */
const HIGHLEVEL = `<html><body><form id="_builder-form" name="builder-form" class="ghl-survey-form">
<input type="text" placeholder="First Name" name="first_name" id="first_name" data-q="first_name" data-required="true">
<input placeholder="Email" name="email" type="email" data-q="email" data-required="true" id="email">
<input type="tel" name="phone" placeholder="Phone" autocomplete="off" id="phone" data-q="phone" data-required="true">
<div class="terms-and-conditions" role="group" aria-label="T &amp; C">
<div class="checkbox-container"><input id="terms_and_conditions_1" value="terms_and_conditions" name="terms_and_conditions" type="checkbox" data-q="terms_and_conditions" data-required="true" aria-required="true" aria-label="By checking this box, I consent to receive transactional messages related to my account, orders, or services I have requested. These messages may include appointment reminders, order confirmations, and account notifications among others. Message frequency may vary. Message &amp; Data rates may apply. Reply HELP for help or STOP to opt-out."><label for="terms_and_conditions_1"><span><p>By checking this box, I consent to receive transactional messages…</p></span></label></div>
<div class="checkbox-container"><input id="terms_and_conditions_2" value="terms_and_conditions" name="terms_and_conditions" type="checkbox" data-q="terms_and_conditions" aria-required="true" aria-label="By checking this box, I consent to receive marketing and promotional messages, including special offers, discounts, new product updates among others. Message frequency may vary. Message &amp; Data rates may apply. Reply HELP for help or STOP to opt-out."><label for="terms_and_conditions_2"><span><p>By checking this box, I consent to receive marketing…</p></span></label></div>
</div><a href="/privacy">Privacy Policy</a><button type="submit">Submit</button></form></body></html>`;

/** GoDaddy's Create Account page: the line about newsletters sits above the form. */
const GODADDY_ACCOUNT = `<html><body><h1>Create Account</h1>
<p>By creating an account, you may receive newsletters or promotions.</p>
<form><input type="text" role="textbox" data-ux="Input" name="nameFirst" placeholder="First name" data-aid="CREATE_ACCOUNT_NAME_FIRST">
<input type="text" role="textbox" data-ux="Input" name="email" placeholder="Email" data-aid="CREATE_ACCOUNT_EMAIL">
<input type="text" role="textbox" data-ux="Input" name="phone" placeholder="Phone" data-aid="CREATE_ACCOUNT_PHONE">
<button type="submit">CREATE ACCOUNT</button></form>
<p>This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.</p></body></html>`;

/** GoDaddy's newsletter sign-up: email only, not a way anybody agrees to texts. */
const NEWSLETTER = `<form><label>Email<input type="text" name="email"></label><button type="submit">SIGN UP</button></form>`;

const ours = smsConsentWords('Shop Your Solar', 'form', `${SITE}/privacy-policy`, `${SITE}/terms`);
/** Our own contact form, as the frame on the home page serves it. */
const HFOS_FORM = `<form><label>Mobile <input type="tel" name="phone"></label>
<label><input type="checkbox" name="smsConsent"> ${ours.title}. ${ours.detail}</label>
<a href="${SITE}/privacy-policy">Privacy policy</a> · <a href="${SITE}/terms">Terms</a><button>Send</button></form>`;

const found = (page: string, html: string, framedUrl?: string): SiteForm[] =>
  formsOn(html).map((f) => ({ ...f, page, framedUrl: framedUrl ?? null }));

const scan = (forms: SiteForm[], over: Partial<SiteScan> = {}): SiteScan => ({
  opened: 5,
  cut: false,
  forms,
  blocked: [],
  ...over,
});

describe('reading the forms on a page', () => {
  it('reads HighLevel’s two boxes: both required, the second for marketing', () => {
    const [form] = formsOn(HIGHLEVEL);
    expect(form?.asksPhone).toBe(true);
    expect(form?.boxes.map((b) => [b.required, b.marketing])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it('reads GoDaddy’s Create Account: a phone number, and the line above it that makes it agreeing', () => {
    const [form] = formsOn(GODADDY_ACCOUNT);
    expect(form?.asksPhone).toBe(true);
    expect(form?.boxes).toEqual([]);
    expect(form?.tiedWords).toBe(
      'By creating an account, you may receive newsletters or promotions',
    );
  });

  it('reads our own form as optional, about the customer’s own business, and tied to nothing', () => {
    const [form] = formsOn(HFOS_FORM);
    expect(form?.asksPhone).toBe(true);
    expect(form?.boxes).toHaveLength(1);
    expect(form?.boxes[0]).toMatchObject({ required: false, preTicked: false, marketing: false });
    expect(form?.tiedWords).toBeNull();
  });

  it('tells a box that starts ticked, and a field named for a mobile with no tel type', () => {
    const [form] = formsOn(
      `<form><input name="Mobile number"><label><input type="checkbox" checked> Text me updates. Reply STOP to stop.</label></form>`,
    );
    expect(form?.asksPhone).toBe(true);
    expect(form?.boxes[0]?.preTicked).toBe(true);
  });

  it('reads fields a page drew without a <form> as one form', () => {
    const forms = formsOn(`<div><input type="tel" name="p"><button>Go</button></div>`);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.asksPhone).toBe(true);
  });

  it('leaves out what isn’t a way to agree to texts: an email box, a search, a sign-in, other tick boxes', () => {
    const forms = formsOn(
      `${NEWSLETTER}<form role="search"><input type="search" name="q"></form>
       <form><input type="email" name="email"><input type="password" name="password"></form>
       <form><input name="telescope-size"><label><input type="checkbox"> Roof repairs</label></form>`,
    );
    expect(forms.map((f) => f.asksPhone || f.boxes.length > 0)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('never takes words in a script for a form', () => {
    expect(formsOn(`<script>const f = '<form><input type="tel"></form>';</script>`)).toEqual([]);
  });
});

describe('addresses', () => {
  it('calls www and not, a trailing slash, a query and a fragment the same page', () => {
    expect(pageKey('https://www.ShopYourSolar.com/Instant-Quote/?a=1#x')).toBe(
      'shopyoursolar.com/instant-quote',
    );
    expect(pageKey('shopyoursolar.com')).toBe('shopyoursolar.com/');
    expect(shortAddress('https://www.shopyoursolar.com/')).toBe('shopyoursolar.com');
  });
});

describe('the forms a reviewer would hold against the registration', () => {
  const home = found(
    `${SITE}/`,
    HFOS_FORM,
    'https://app.handsfreeos.com/f/shop-your-solar/contact-form?embed=1',
  );
  const quote = found(
    `${SITE}/instant-quote`,
    HIGHLEVEL,
    'https://instantquote.shopyoursolar.com/instant-quote-ai-922506',
  );
  const account = found(`${SITE}/m/create-account`, GODADDY_ACCOUNT);

  it('passes a site whose only phone form is the one named, with one green row', () => {
    const checks = checkSiteForms(scan([...home, ...found(`${SITE}/`, NEWSLETTER)]), {
      named: ['https://shopyoursolar.com'],
      useCase: 'customer_care',
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'site_forms', ok: true });
    expect(checks[0]?.detail).toContain('5 pages');
  });

  it('turns down Shop Your Solar as the reviewer did: the instant quote form and Create Account (30923)', () => {
    const checks = checkSiteForms(scan([...home, ...quote, ...account]), {
      named: ['https://shopyoursolar.com'],
      useCase: 'customer_care',
    });
    expect(checks.map((c) => [c.id, c.ok, c.severity, c.url])).toEqual([
      ['site_form_0', false, 'blocker', `${SITE}/instant-quote`],
      ['site_form_1', false, 'blocker', `${SITE}/m/create-account`],
    ]);
    const [q, a] = checks;
    expect(q?.label).toBe('A form on shopyoursolar.com/instant-quote');
    expect(q?.detail).toContain('from instantquote.shopyoursolar.com');
    expect(q?.detail).toContain('doesn’t name it');
    expect(q?.detail).toContain('have to be ticked');
    expect(q?.detail).toContain('marketing texts');
    expect(q?.detail).toContain('“How customers agree”');
    expect(a?.detail).toContain('asks for a phone number');
    expect(a?.detail).toContain(
      '“By creating an account, you may receive newsletters or promotions”',
    );
  });

  it('still turns down a named form whose second box is required or for marketing', () => {
    const checks = checkSiteForms(scan(quote), {
      named: ['https://instantquote.shopyoursolar.com/instant-quote-ai-922506'],
      useCase: 'customer_care',
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.detail).not.toContain('doesn’t name it');
    expect(checks[0]?.detail).toContain('have to be ticked');
    expect(checks[0]?.detail).toContain('marketing texts');
  });

  it('allows a marketing box when the registration says the texts include offers', () => {
    const optional = found(
      `${SITE}/offers`,
      `<form><input type="tel" name="phone"><label><input type="checkbox"> Text me special offers. Message frequency varies. Reply STOP to stop.</label></form>`,
    );
    for (const useCase of ['mixed', 'marketing'])
      expect(checkSiteForms(scan(optional), { named: [`${SITE}/offers`], useCase })[0]?.ok).toBe(
        true,
      );
    expect(
      checkSiteForms(scan(optional), { named: [`${SITE}/offers`], useCase: 'customer_care' })[0]
        ?.ok,
    ).toBe(false);
  });

  it('counts a footer form on every page once, saying where else it is', () => {
    const pages = ['/', '/about', '/services', '/faq', '/contact'].map((p) => `${SITE}${p}`);
    const footer = `<form><input type="tel" name="phone" placeholder="Your cell"><button>Call me</button></form>`;
    const checks = checkSiteForms(scan(pages.flatMap((p) => found(p, footer))), {
      named: [],
      useCase: 'customer_care',
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.detail).toContain(
      'also on shopyoursolar.com/about, shopyoursolar.com/services and 2 more pages',
    );
  });

  it('says when it couldn’t look at every page, and names the pages a robot check stopped it on', () => {
    const [check] = checkSiteForms(
      scan(home, {
        opened: 40,
        cut: true,
        blocked: [
          { url: `${SITE}/pricing`, who: 'your website’s security (SiteGround)', by: 'SiteGround' },
        ],
      }),
      { named: [SITE], useCase: 'customer_care' },
    );
    expect(check).toMatchObject({ id: 'site_forms', ok: false, severity: 'warning' });
    expect(check?.detail).toContain('stopped after 40 pages');
    expect(check?.detail).toContain('SiteGround');
    expect(check?.detail).toContain('Finish the check on my site');
    expect(check?.blocked).toEqual([{ url: `${SITE}/pricing`, by: 'SiteGround' }]);
  });

  it('keeps the pages it couldn’t look at beside the forms it found to fix, so neither is missed', () => {
    const checks = checkSiteForms(
      scan([...home, ...found(`${SITE}/instant-quote`, HIGHLEVEL)], {
        blocked: [
          { url: `${SITE}/pricing`, who: 'your website’s security (SiteGround)', by: 'SiteGround' },
        ],
      }),
      { named: [SITE], useCase: 'customer_care' },
    );
    expect(checks.map((c) => c.id)).toEqual(['site_form_0', 'site_forms']);
    expect(checks[1]).toMatchObject({ ok: false, label: 'Pages we couldn’t look at' });
    expect(checks[1]?.blocked).toEqual([{ url: `${SITE}/pricing`, by: 'SiteGround' }]);
  });

  it('says nothing when the site didn’t open: the website’s own row says so', () => {
    expect(checkSiteForms(scan([], { opened: 0 }), { named: [SITE] })).toEqual([]);
    expect(checkSiteForms(null, { named: [SITE] })).toEqual([]);
  });
});

describe('what’s on the site now, before the business picks how customers agree', () => {
  const FRAME = 'https://app.handsfreeos.com/f/shop-your-solar/get-in-touch';
  const isOurs = (url: string) => url.startsWith('https://app.handsfreeos.com/f/shop-your-solar/');
  const all = scan([
    ...found(`${SITE}/instant-quote`, HIGHLEVEL, 'https://instantquote.shopyoursolar.com/quote'),
    ...found(`${SITE}/m/create-account`, GODADDY_ACCOUNT),
    ...found(`${SITE}/`, HFOS_FORM, FRAME),
    ...found(`${SITE}/contact`, HFOS_FORM, FRAME),
  ]);

  it('lists each form once, with the page it’s on, and knows the business’s own form', () => {
    const forms = siteFormsFound(all, isOurs);
    expect(forms).toHaveLength(3);
    expect(forms[0]).toMatchObject({
      page: `${SITE}/instant-quote`,
      alsoOn: 0,
      asksPhone: true,
      asksToText: true,
      ours: false,
    });
    expect(forms[1]).toMatchObject({
      page: `${SITE}/m/create-account`,
      framedUrl: null,
      asksToText: false,
      ours: false,
    });
    // Our form framed on two pages is one row, on the first page it was found on.
    expect(forms[2]).toMatchObject({ page: `${SITE}/`, alsoOn: 1, framedUrl: FRAME, ours: true });
  });

  it('says how many pages opened and what the other forms ask, leaving the business’s own form out', () => {
    const forms = siteFormsFound(all, isOurs);
    expect(siteFormsSummary({ opened: 14, cut: false, forms }, 'shopyoursolar.com')).toBe(
      'We opened 14 pages of shopyoursolar.com and found 2 forms that ask for a phone number. 1 of them asks to text too.',
    );
    const account = forms.filter((f) => f.page.endsWith('/create-account'));
    expect(siteFormsSummary({ opened: 1, cut: true, forms: account }, 'shopyoursolar.com')).toBe(
      'We opened 1 page of shopyoursolar.com and found 1 form that asks for a phone number. It doesn’t ask to text. We stopped there, so there may be more.',
    );
    expect(
      siteFormsSummary({ opened: 3, cut: false, forms: [...account, ...account] }, 'a.com'),
    ).toContain('Neither one asks to text.');
  });

  it('says so when only the business’s own form is there, and nothing when no page opened', () => {
    const mine = siteFormsFound(scan(found(`${SITE}/`, HFOS_FORM, FRAME)), isOurs);
    expect(siteFormsSummary({ opened: 6, cut: false, forms: mine }, 'shopyoursolar.com')).toBe(
      'We opened 6 pages of shopyoursolar.com and found no forms that ask for a phone number.',
    );
    expect(siteFormsSummary({ opened: 0, cut: false, forms: [] }, 'shopyoursolar.com')).toBeNull();
  });
});
