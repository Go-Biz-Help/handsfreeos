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
  checkChatOnSite,
  checkOptInSurface,
  checkOtherWay,
  confirmationsFor,
  framedAddresses,
  notGreen,
  SIGN_UP_MARK,
  takesSignUps,
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
  termsGaps,
  tradingName,
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

/** What SiteGround's robot check sends our server instead of a page (Full Spectrum, 13 Nov 2026). */
const robotChecked = (path: string): Partial<FetchedPage> => ({
  status: 202,
  html: `<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=${encodeURIComponent(path)}&y=ipr:203.0.113.7:1762990000.123"></meta></head></html>`,
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
      'Privacy. We never sell or share your mobile phone number with anyone. Text messages you receive from us are about your appointments. Msg frequency varies; msg & data rates may apply.';
    expect(promisesNotToShare(pageText(text))).toBe(true);
    expect(checkPolicy(page({ html: text })).ok).toBe(true);
  });

  it('fails a policy that promises not to share but never says how often or that rates apply (30896)', () => {
    const text =
      'Privacy. We never sell or share your mobile phone number with anyone. Text messages you receive from us are about your appointments.';
    const check = checkPolicy(page({ html: text }));
    expect(check).toMatchObject({ ok: false, severity: 'blocker' });
    expect(check.detail).toMatch(/Message frequency varies/);
    expect(check.detail).toMatch(/Message and data rates may apply/);
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

  it('says a robot check stopped us, rather than that the policy never mentions texting', () => {
    const check = checkPolicy(page(robotChecked('/privacy-policy/')));
    expect(check.ok).toBe(false);
    expect(check.severity).toBe('blocker');
    expect(check.detail).toMatch(/robot check .*\(SiteGround\)/);
    expect(check.detail).toMatch(/Ask HandsFreeOS to check it/);
    expect(check.detail).not.toMatch(/never mentions/);
  });

  it('says the same for a robot check that answers 403, rather than that the page is broken', () => {
    const check = checkPolicy(
      page({
        status: 403,
        html: '<html><head><title>Just a moment...</title></head><body>Verifying you are human.</body></html>',
      }),
    );
    expect(check.detail).toMatch(/robot check .*\(Cloudflare\)/);
    expect(check.detail).not.toMatch(/answered 403/);
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

  it('says a robot check stopped us, rather than that the site opens onto almost nothing', () => {
    const check = checkWebsite(page(robotChecked('/')));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/robot check/);
    expect(check.detail).not.toMatch(/almost nothing/i);
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

  it('asks a business with a DBA to show both names, so the reviewer can tie them together', () => {
    const both = page({
      html: `<html><body>${'HandsFreeOS answers your leads. '.repeat(10)}<footer>HandsFreeOS is a product of Go Biz Help LLC.</footer></body></html>`,
    });
    expect(checkWebsite(both, ['HandsFreeOS', 'Go Biz Help LLC'], 'Go Biz Help LLC').ok).toBe(true);

    const dbaOnly = page({
      html: `<html><body>${'HandsFreeOS answers your leads. '.repeat(10)}</body></html>`,
    });
    const check = checkWebsite(dbaOnly, ['HandsFreeOS', 'Go Biz Help LLC'], 'Go Biz Help LLC');
    expect(check).toMatchObject({ ok: false, severity: 'warning' });
    expect(check.detail).toMatch(/couldn’t find “Go Biz Help LLC”/);
    expect(check.detail).toMatch(/HandsFreeOS is owned and run by Go Biz Help LLC/);

    // The same name with or without its LLC is not a DBA, so one of them on the page is enough.
    expect(
      checkWebsite(page(), ['Lone Star HVAC', 'Lone Star HVAC LLC'], 'Lone Star HVAC LLC').ok,
    ).toBe(true);
  });

  it('calls a name a DBA only when it is clearly a different name', () => {
    expect(tradingName('Go Biz Help LLC', 'HandsFreeOS')).toBe('HandsFreeOS');
    expect(tradingName('Dale Rivera', 'Rivera Plumbing')).toBe('Rivera Plumbing');
    expect(tradingName('Lone Star HVAC LLC', 'Lone Star HVAC')).toBeNull();
    expect(tradingName('Lone Star Heating LLC', 'Lone Star')).toBeNull();
    expect(tradingName('Go Biz Help LLC', 'GoBizHelp')).toBeNull();
    expect(tradingName('', 'HandsFreeOS')).toBeNull();
    expect(tradingName('Go Biz Help LLC', null)).toBeNull();
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

  it('keeps terms behind a robot check a warning, as terms that never mention texting would be', () => {
    const check = checkTerms(page(robotChecked('/terms-of-service/')));
    expect(check).toMatchObject({ ok: false, severity: 'warning' });
    expect(check.detail).toMatch(/robot check .*\(SiteGround\)/);
  });

  it('names what terms that mention texting leave out, without blocking', () => {
    const html =
      '<h1>Terms</h1><p>We may send you text messages about your appointment. Reply STOP to stop.</p>';
    const check = checkTerms(page({ html }));
    expect(check).toMatchObject({ ok: false, severity: 'warning' });
    expect(check.detail).toMatch(/how many messages they get varies/);
    expect(check.detail).toMatch(/message and data rates may apply/);
    expect(check.detail).toMatch(/HELP/);
    expect(check.detail).toMatch(/how to reach you/);
    expect(check.detail).not.toMatch(/STOP stops/);
  });

  it('finds nothing missing from the texting section we offer to copy', () => {
    const terms = termsOfService({ name: 'Go Biz Help', phone: '(512) 555-0100' });
    const section = terms.sections.find((x) => x.heading === 'Text messages')!;
    expect(termsGaps(pageText(section.paragraphs.join(' ')))).toEqual([]);
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
    expect(
      checkOptInSurface(page({ html: consentHtml() }), 'own_site', ['Lone Star HVAC']).ok,
    ).toBe(true);
  });

  it('passes our sign-up page only when sending it really signs someone up', () => {
    const live = consentHtml().replace('<form>', `<form ${SIGN_UP_MARK}="live">`);
    expect(takesSignUps(live)).toBe(true);
    expect(checkOptInSurface(page({ html: live }), 'hosted', ['Lone Star HVAC']).ok).toBe(true);
    // The page the 1 Nov reviewer pressed Send on: the form, but a Send that only said it was a picture.
    const shown = consentHtml().replace(
      '</form>',
      '<p>This page only shows what the chat asks. To reach Lone Star HVAC, use the chat on their website.</p></form>',
    );
    const check = checkOptInSurface(page({ html: shown }), 'hosted', ['Lone Star HVAC']);
    expect(check).toMatchObject({ ok: false, severity: 'blocker' });
    expect(check.detail).toMatch(/doesn’t sign anyone up/);
    expect(check.detail).toMatch(/Ask HandsFreeOS to check it/);
  });

  it('turns down words by the phone field that don’t name the kinds of texts or say how often (30924)', () => {
    // As the 23 Oct reviewer read it: who, STOP, even rates, but no kinds of texts and no frequency phrasing.
    const html =
      '<form><input type="tel" name="phone"><input type="checkbox" id="c">' +
      '<label for="c">By providing your phone number you agree to receive text messages from Shop Your Solar. ' +
      'Message and data rates may apply. Reply STOP to opt out, HELP for help.</label>' +
      '<a href="/privacy">Privacy policy</a> <a href="/terms">Terms</a></form>';
    const check = checkOptInSurface(page({ html }), 'own_site', ['Shop Your Solar']);
    expect(check).toMatchObject({ ok: false, severity: 'blocker' });
    expect(check.detail).toMatch(/kinds of texts/);
    expect(check.detail).toMatch(/Message frequency varies/);
  });

  it('turns down “how many messages you get varies”, our old paraphrase of the frequency', () => {
    const html =
      '<form><input type="checkbox" id="c"><label for="c">Lone Star HVAC may text you appointment reminders. ' +
      'How many messages you get varies, and message and data rates may apply. Reply STOP to stop and HELP for help.' +
      '</label><a href="/privacy">Privacy policy</a> <a href="/terms">Terms</a></form>';
    expect(readConsentBox(html, ['Lone Star HVAC']).missing).toEqual([
      'the words “Message frequency varies”',
    ]);
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
      'kinds of texts',
      'HELP',
      'rates may apply',
      'Message frequency varies',
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

  it('says so when the box was found in a form framed on the page, keeping the page’s address', () => {
    const form = 'https://app.handsfreeos.test/f/lone-star/contact';
    const check = checkOptInSurface(page({ html: consentHtml(), framedUrl: form }), 'own_site', [
      'Lone Star HVAC',
    ]);
    expect(check.ok).toBe(true);
    expect(check.url).toBe('https://lonestarhvac.test');
    expect(check.detail).toContain(form);
  });
});

describe('forms framed on a page (a reviewer’s browser shows them; the page’s HTML only has the frame)', () => {
  const FORM = 'https://app.handsfreeos.com/f/shop-your-solar/contact-form?embed=1';

  it('reads our own snippet’s frame', () => {
    const html = `<main><iframe src="${FORM}" title="Contact" width="100%"></iframe><script src="https://app.handsfreeos.com/embed/v1/form.js" async></script></main>`;
    expect(framedAddresses(html, 'https://shopyoursolar.com/')).toEqual([FORM]);
  });

  it('reads a frame a website builder wrapped ours in, written into srcdoc (shopyoursolar.com, 11 Nov)', () => {
    const inner =
      "<script>window.onmessage = function(event) {};</script><body style='margin: 0'>" +
      `<iframe src="${FORM}" title="Contact Form" loading="lazy"></iframe></body>`;
    const escaped = inner
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
    const html =
      '<div><iframe id="iframe-73854" frameBorder="0" sandbox="allow-scripts allow-same-origin allow-forms" ' +
      'src="javascript: window.frameElement.getAttribute(&quot;srcdoc&quot;);" ' +
      `srcDoc="${escaped}" style="width:100%"></iframe></div>`;
    expect(framedAddresses(html, 'https://shopyoursolar.com/')).toEqual([FORM]);
  });

  it('makes a relative address whole, reads late-loading frames, and keeps each address once', () => {
    const html =
      '<iframe src="/contact-form"></iframe><iframe data-src="https://forms.test/a#top"></iframe>' +
      '<iframe src="https://forms.test/a"></iframe><iframe src="about:blank"></iframe>';
    expect(framedAddresses(html, 'https://site.test/contact')).toEqual([
      'https://site.test/contact-form',
      'https://forms.test/a',
    ]);
  });

  it('opens a few at most, and never the page itself or a frame inside a script', () => {
    const many = Array.from(
      { length: 6 },
      (_, i) => `<iframe src="https://f.test/${i}"></iframe>`,
    ).join('');
    expect(framedAddresses(many, 'https://site.test/')).toHaveLength(3);
    expect(
      framedAddresses('<iframe src="https://site.test/"></iframe>', 'https://site.test/'),
    ).toEqual([]);
    expect(
      framedAddresses(
        '<script>document.write(\'<iframe src="https://f.test/x"></iframe>\')</script>',
        'https://site.test/',
      ),
    ).toEqual([]);
  });
});

describe('whether the chat is on the website (letting us collect it)', () => {
  const KEY = 'wk_AbCdEfGhIjKlMnOpQrSt';
  const chat = (over: Partial<{ seenOrigin: string | null; paused: boolean }> = {}) => ({
    key: KEY,
    seenOrigin: null,
    paused: false,
    ...over,
  });
  const withSnippet = page({
    html: `<html><body>Lone Star HVAC<script async src="https://app.handsfreeos.com/embed/v1/${KEY}.js"></script></body></html>`,
  });

  it('finds the snippet in the page, however the site builder escapes it', () => {
    expect(checkChatOnSite(withSnippet, [chat()])).toMatchObject({ ok: true });
    const escaped = page({
      html: `<script>window.__footer="<script src=\\"https:\\/\\/app.handsfreeos.com\\/embed\\/v1\\/${KEY}.js\\">"</script>`,
    });
    expect(checkChatOnSite(escaped, [chat()]).ok).toBe(true);
  });

  it('takes the install check seeing it open on the same site, www or not', () => {
    const check = checkChatOnSite(page(), [chat({ seenOrigin: 'https://www.lonestarhvac.test' })]);
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain('lonestarhvac.test');
    // Seen somewhere else doesn't count: the reviewer opens this website.
    expect(checkChatOnSite(page(), [chat({ seenOrigin: 'https://other.test' })]).ok).toBe(false);
  });

  it('blocks when the chat isn’t there, and says where to paste it', () => {
    const check = checkChatOnSite(page(), [chat()]);
    expect(check).toMatchObject({ ok: false, severity: 'blocker' });
    expect(check.detail).toContain('lonestarhvac.test');
    expect(check.detail).toMatch(/footer/);
  });

  it('blocks with no chat, or only a paused one, saying what to do', () => {
    expect(checkChatOnSite(withSnippet, []).detail).toMatch(/Set this up for me/);
    const paused = checkChatOnSite(withSnippet, [chat({ paused: true })]);
    expect(paused.ok).toBe(false);
    expect(paused.detail).toMatch(/paused/);
  });

  it('still takes the install check when the website didn’t open for us', () => {
    const down = page({ status: null, html: '', error: 'timeout' });
    expect(checkChatOnSite(down, [chat({ seenOrigin: 'https://lonestarhvac.test' })]).ok).toBe(
      true,
    );
    expect(checkChatOnSite(down, [chat()]).ok).toBe(false);
  });
});

describe('other ways customers agree', () => {
  const words = smsConsentWords('Lone Star HVAC', 'form', '/privacy');
  const box =
    `<form><input type="checkbox" id="c"><label for="c">${words.title}</label><p>${words.detail} ` +
    '<a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a></p></form>';

  it('checks each one like the main one, numbered in the order given', () => {
    const ok = checkOtherWay(page({ html: box }), { path: 'own_site' }, 0, ['Lone Star HVAC']);
    expect(ok).toMatchObject({ id: 'other_way_0', ok: true });
    expect(ok.label).toMatch(/own website form/);
    const down = checkOtherWay(page({ status: 404, html: '' }), { path: 'in_person' }, 1);
    expect(down).toMatchObject({ id: 'other_way_1', ok: false, severity: 'blocker' });
  });

  it('says so when the chat was listed but never set up', () => {
    expect(checkOtherWay(null, { path: 'hosted' }, 0).detail).toMatch(/isn’t set up/);
  });
});

describe('what only the business can say', () => {
  it('asks a business with its own form to try it, and everyone to say the list is complete', () => {
    expect(
      confirmationsFor({ optInPath: 'own_site', optInUrl: 'https://shopyoursolar.test/quote' }).map(
        (c) => c.id,
      ),
    ).toEqual(['own_form_sends', 'only_these_ways']);
    expect(
      confirmationsFor({
        optInPath: 'hosted',
        otherWays: [{ path: 'in_person', url: 'https://drive.test/sheet' }],
      }).map((c) => c.id),
    ).toEqual(['in_person_words', 'only_these_ways']);
    expect(confirmationsFor({ optInPath: '' })).toEqual([]);
  });
});

describe('all green', () => {
  const green = checkWebsite(page());
  it('is nothing left: no issue of either kind, every look passed, every tick ticked', () => {
    const confirmations = confirmationsFor({ optInPath: 'hosted' });
    expect(
      notGreen({ issues: [], checks: [green], confirmations, confirmed: ['only_these_ways'] }),
    ).toEqual([]);
  });

  it('lists warnings too, the checks not run, and each tick left empty', () => {
    const yellow = checkWebsite(page(), ['Somebody Else Plumbing']);
    expect(yellow.severity).toBe('warning');
    const left = notGreen({
      issues: [{ message: 'Is this exactly the name on your EIN letter?' }],
      checks: [green, yellow],
      confirmations: confirmationsFor({ optInPath: 'hosted' }),
      confirmed: [],
    });
    expect(left).toHaveLength(3);
    expect(left[1]).toMatch(/^Your website opens: /);
    expect(left[2]).toMatch(/^Not ticked/);
    expect(notGreen({ issues: [], checks: null, confirmations: [], confirmed: [] })[0]).toMatch(
      /haven’t run/,
    );
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
