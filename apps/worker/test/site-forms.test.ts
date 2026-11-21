import type { FetchedPage } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import type { SafeFetch } from '../src/http/safe-fetch';
import { SITE_SCAN_LIMITS, scanSiteForms } from '../src/http/site-forms';

/**
 * Going through a whole website for forms before a texting registration goes (owner, 2026-11-18), shaped like Shop
 * Your Solar's site when its campaign was turned down: a GoDaddy home page with our form framed in it, /instant-quote
 * framing a HighLevel form on a subdomain, and a Create Account page that asks for a phone number.
 */

const SITE = 'https://shopyoursolar.test';
const QUOTE_FORM = 'https://instantquote.shopyoursolar.test/instant-quote-ai-922506';
const OUR_FORM = 'https://app.handsfreeos.test/f/shop-your-solar/contact-form?embed=1';

/** GoDaddy's embed: its own frame, with the pasted frame written inside it into `srcdoc`. */
const frameOf = (src: string) =>
  `<iframe src="javascript: window.frameElement.getAttribute(&quot;srcdoc&quot;);" srcdoc="&lt;body&gt;&lt;iframe src=&quot;${src}&quot;&gt;&lt;/iframe&gt;&lt;/body&gt;"></iframe>`;

const NAV = `<nav><a href="/">Home</a> <a href="/instant-quote">Instant-Quote</a> <a href="/m/create-account">Create Account</a>
<a href="mailto:hi@shopyoursolar.test">Email</a> <a href="https://facebook.test/shopyoursolar">Facebook</a> <a href="/brochure.pdf">Brochure</a></nav>
<form><label>Email<input type="text" name="email"></label><button>SIGN UP</button></form>`;

const pages: Record<string, { body: string; type?: string; status?: number }> = {
  [`${SITE}/`]: {
    body: `<html><body>${NAV}<h1>Shop Your Solar</h1>${frameOf(OUR_FORM)}</body></html>`,
  },
  [`${SITE}/instant-quote`]: { body: `<html><body>${NAV}${frameOf(QUOTE_FORM)}</body></html>` },
  [`${SITE}/m/create-account`]: {
    body: `<html><body>${NAV}<p>By creating an account, you may receive newsletters or promotions.</p>
<form><input type="text" name="nameFirst"><input type="text" name="phone" placeholder="Phone"><button>CREATE ACCOUNT</button></form></body></html>`,
  },
  [`${SITE}/robots.txt`]: {
    body: `User-agent: *\nDisallow: /404\nSitemap: ${SITE}/sitemap.xml`,
    type: 'text/plain',
  },
  [`${SITE}/sitemap.xml`]: {
    body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${SITE}/sitemap.website.xml</loc></sitemap></sitemapindex>`,
    type: 'application/xml',
  },
  [`${SITE}/sitemap.website.xml`]: {
    body: `<?xml version="1.0"?><urlset><url><loc>${SITE}/</loc></url><url><loc>${SITE}/about</loc></url></urlset>`,
    type: 'application/xml',
  },
  [`${SITE}/about`]: { body: `<html><body>${NAV}<p>About us</p></body></html>` },
  [QUOTE_FORM]: {
    body: `<form><input type="tel" name="phone" data-required="true">
<input type="checkbox" name="terms_and_conditions" data-required="true" aria-required="true" aria-label="By checking this box, I consent to receive transactional messages. Message frequency may vary. Reply HELP for help or STOP to opt-out.">
<input type="checkbox" name="terms_and_conditions" aria-required="true" aria-label="By checking this box, I consent to receive marketing and promotional messages. Reply STOP to opt-out."></form>`,
  },
  [OUR_FORM]: {
    body: `<form><input type="tel" name="phone"><label><input type="checkbox" name="sms"> Text me, Shop Your Solar. Appointment reminders and quotes. Message frequency varies. Reply STOP to unsubscribe.</label></form>`,
  },
};

function site(over: typeof pages = {}): { fetchUrl: SafeFetch; asked: string[] } {
  const all = { ...pages, ...over };
  const asked: string[] = [];
  const fetchUrl: SafeFetch = async (url) => {
    asked.push(url);
    const page = all[url];
    const body = page?.body ?? '';
    return {
      status: page ? (page.status ?? 200) : 404,
      headers: { 'content-type': page?.type ?? 'text/html; charset=utf-8' },
      body,
      bytes: Buffer.from(body),
      finalUrl: url,
      truncated: false,
    };
  };
  return { fetchUrl, asked };
}

describe('going through a whole website for forms', () => {
  it('finds every form that asks for a phone number, framed ones included, on every page it can reach', async () => {
    const { fetchUrl, asked } = site();
    const scan = await scanSiteForms({ fetchUrl }, 'shopyoursolar.test');
    expect(scan.opened).toBe(4);
    expect(scan.cut).toBe(false);
    const where = scan.forms.map((f) => [f.page, f.framedUrl ?? null]);
    expect(where).toEqual(
      expect.arrayContaining([
        [`${SITE}/`, OUR_FORM],
        [`${SITE}/instant-quote`, QUOTE_FORM],
        [`${SITE}/m/create-account`, null],
      ]),
    );
    // The email-only newsletter on every page doesn't count; mail, other sites and files are never opened.
    expect(scan.forms).toHaveLength(3);
    expect(asked.some((u) => /facebook|mailto|\.pdf/.test(u))).toBe(false);
    // Each page and each framed form opened once.
    expect(asked.filter((u) => u === QUOTE_FORM)).toHaveLength(1);
    expect(asked.filter((u) => u === `${SITE}/`)).toHaveLength(1);
  });

  it('doesn’t fetch a page the review already read, unless what it holds is a framed form’s', async () => {
    const { fetchUrl, asked } = site();
    const home: FetchedPage = { url: `${SITE}/`, status: 200, html: pages[`${SITE}/`]!.body };
    const framed: FetchedPage = {
      url: `${SITE}/instant-quote`,
      status: 200,
      html: pages[QUOTE_FORM]!.body,
      framedUrl: QUOTE_FORM,
    };
    await scanSiteForms({ fetchUrl }, `${SITE}/`, [home, framed, null]);
    expect(asked).not.toContain(`${SITE}/`);
    expect(asked).toContain(`${SITE}/instant-quote`);
  });

  it('says a robot check stopped it, and never reads the check as a page', async () => {
    const { fetchUrl } = site({
      [`${SITE}/about`]: {
        status: 202,
        body: '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fabout"></head></html>',
      },
    });
    const scan = await scanSiteForms({ fetchUrl }, SITE);
    expect(scan.blocked).toEqual([
      { url: `${SITE}/about`, who: 'your website’s security (SiteGround)', by: 'SiteGround' },
    ]);
    expect(scan.opened).toBe(3);
  });

  it('stops at its page limit and says it was cut short', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `${SITE}/p${i}`,
        { body: `<html><body><a href="/p${i + 1}">next</a></body></html>` },
      ]),
    );
    const { fetchUrl } = site({
      ...many,
      [`${SITE}/`]: { body: '<html><body><a href="/p0">start</a></body></html>' },
    });
    const scan = await scanSiteForms({ fetchUrl }, SITE, [], { ...SITE_SCAN_LIMITS, pages: 5 });
    expect(scan.opened).toBe(5);
    expect(scan.cut).toBe(true);
  });
});
