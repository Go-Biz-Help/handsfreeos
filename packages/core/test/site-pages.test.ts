/**
 * The texting registration's ways past a website's security (owner, 2026-11-20): one key for a page however it's
 * written, pages trimmed to what the checks read, a screenshot that has to be of the page, and each host's steps for
 * letting HandsFreeOS in.
 */
import { describe, expect, it } from 'vitest';
import { formsOn } from '../src/messaging/site-forms';
import { robotCheck, robotCheckAllow, SITE_READER_AGENT } from '../src/websites/robot-check';
import {
  onSiteHost,
  screenshotRefusal,
  siteHost,
  sitePageKey,
  trimPageHtml,
} from '../src/websites/site-pages';

describe('a page’s key', () => {
  it('is the same however the address is written', () => {
    const key = 'fullspectrumlighttherapy.com/contact';
    expect(sitePageKey('https://www.fullspectrumlighttherapy.com/contact/')).toBe(key);
    expect(sitePageKey('http://fullspectrumlighttherapy.com/contact')).toBe(key);
    expect(sitePageKey('fullspectrumlighttherapy.com/contact#form')).toBe(key);
    expect(sitePageKey('https://FullSpectrumLightTherapy.com')).toBe(
      'fullspectrumlighttherapy.com/',
    );
    expect(sitePageKey('https://a.test/p?b=2&a=1')).toBe(sitePageKey('https://a.test/p?a=1&b=2'));
    expect(sitePageKey('mailto:hi@a.test')).toBeNull();
  });

  it('knows a site’s own pages, subdomains included', () => {
    expect(siteHost('https://www.shopyoursolar.com/x')).toBe('shopyoursolar.com');
    expect(onSiteHost('instantquote.shopyoursolar.com', 'shopyoursolar.com')).toBe(true);
    expect(onSiteHost('www.shopyoursolar.com', 'shopyoursolar.com')).toBe(true);
    expect(onSiteHost('notshopyoursolar.com', 'shopyoursolar.com')).toBe(false);
    expect(onSiteHost('evil.test', 'shopyoursolar.com')).toBe(false);
  });
});

describe('a page trimmed to what the checks read', () => {
  it('keeps the forms, words, links and the chat’s script, and drops the bulk', () => {
    const html = `<html><head><style>${'body{color:red}'.repeat(500)}</style>
      <script>${'var x=1;'.repeat(1000)}</script>
      <script async src="https://app.handsfreeos.com/embed/v1/wk_ABCDEFGHIJKLMNOPQRST.js"></script></head>
      <body><!-- a comment --><svg>${'<path d="M0 0"/>'.repeat(200)}</svg>
      <img src="data:image/png;base64,${'A'.repeat(5000)}">
      <form><label>Mobile <input type="tel" name="phone"></label>
      <label><input type="checkbox" name="sms" required> I agree to texts</label></form>
      <a href="/privacy-policy">Privacy</a></body></html>`;
    const trimmed = trimPageHtml(html);
    expect(trimmed.length).toBeLessThan(html.length / 4);
    expect(trimmed).toContain('wk_ABCDEFGHIJKLMNOPQRST.js');
    expect(trimmed).toContain('href="/privacy-policy"');
    expect(trimmed).not.toContain('a comment');
    // The form reads the same afterwards.
    expect(formsOn(trimmed)).toEqual(formsOn(html));
  });

  it('still shows a robot check as one', () => {
    const check =
      '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>';
    expect(robotCheck({ status: 202, html: trimPageHtml(check) })).toEqual({ by: 'SiteGround' });
  });
});

describe('a screenshot standing in for a page', () => {
  const page = '<h1>Contact us</h1><form><input type="tel"></form>';
  it('has to be a web page', () => {
    expect(
      screenshotRefusal('https://a.test/contact', { isWebPage: false, addressShown: '', html: '' }),
    ).toMatch(/doesn’t look like a web page/);
    expect(
      screenshotRefusal('https://a.test/contact', {
        isWebPage: true,
        addressShown: '',
        html: page,
      }),
    ).toBeNull();
  });

  it('has to be of the same site when its address shows', () => {
    expect(
      screenshotRefusal('https://a.test/contact', {
        isWebPage: true,
        addressShown: 'other.test/contact',
        html: page,
      }),
    ).toMatch(/shows other\.test, not a\.test/);
    expect(
      screenshotRefusal('https://a.test/contact', {
        isWebPage: true,
        addressShown: 'https://www.a.test/contact',
        html: page,
      }),
    ).toBeNull();
  });
});

describe('letting HandsFreeOS in', () => {
  const site = { host: 'fullspectrumlighttherapy.com', ips: ['203.0.113.9', '2001:db8::9'] };

  it('offers nothing until the fixed addresses are set up', () => {
    expect(robotCheckAllow('SiteGround', { ...site, ips: [] })).toBeNull();
  });

  it('gives SiteGround’s support a message to paste, naming the site, the addresses and our name', () => {
    const allow = robotCheckAllow('SiteGround', site)!;
    expect(allow.steps).toMatch(/no switch/);
    expect(allow.message).toContain('fullspectrumlighttherapy.com');
    expect(allow.message).toContain('203.0.113.9, 2001:db8::9');
    expect(allow.message).toContain(SITE_READER_AGENT);
  });

  it('gives the steps where the business can do it itself', () => {
    expect(robotCheckAllow('Cloudflare', site)).toMatchObject({ message: null });
    expect(robotCheckAllow('Cloudflare', site)!.steps).toMatch(/Skip/);
    expect(robotCheckAllow('Wordfence', site)!.steps).toMatch(/Allowlisted IP addresses/);
    expect(robotCheckAllow('Sucuri', site)!.steps).toMatch(/Allowlist IP/);
    expect(robotCheckAllow(null, site)!.message).toContain('203.0.113.9');
  });
});
