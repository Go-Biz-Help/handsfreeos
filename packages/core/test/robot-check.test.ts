/**
 * The page a website's host shows a bot instead of the page asked for (13 Nov 2026: SiteGround answered our reads of
 * Full Spectrum's terms, and half its pages in a Knowledge scan, with one). Told apart from a real page, so a reader
 * says "a robot check stopped us" rather than "this page has no words".
 */
import { describe, expect, it } from 'vitest';
import { robotCheck, robotCheckWhy } from '../src/websites/robot-check';

/** SiteGround's answer, as our server got it: a 202 whose whole body sends the visitor to its check. */
const SITEGROUND_202 =
  '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fterms-of-service%2F&y=ipr:203.0.113.7:1762990000.123"></meta></head></html>';

/** The check page that refresh leads to: a script and a title, no words of the business's. */
const SITEGROUND_CHECK =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="ROBOTS" content="NOINDEX, NOFOLLOW"><noscript><meta http-equiv="refresh" content="0;/.well-known/captcha/?r=/"></noscript><title>Robot Challenge Screen</title><script>const sgchallenge="20:1762990000:abc";</script></head><body></body></html>';

const CLOUDFLARE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><script>(function(){window._cf_chl_opt={cZone:"acme.test"};}())</script></head><body><noscript>Enable JavaScript and cookies to continue</noscript><div>acme.test needs to review the security of your connection before proceeding.</div></body></html>';

const TERMS = `<html><body><main><h1>Terms of Service</h1>${'<p>By booking a session with Full Spectrum Light Therapy, LLC you agree to these terms, which cover payments, cancellations and how we contact you.</p>'.repeat(20)}</main></body></html>`;

describe('a robot check instead of the page', () => {
  it('knows SiteGround’s, whether the refresh to it or the check page itself', () => {
    expect(robotCheck({ status: 202, html: SITEGROUND_202 })).toEqual({ by: 'SiteGround' });
    expect(robotCheck({ status: 200, html: SITEGROUND_CHECK })).toEqual({ by: 'SiteGround' });
  });

  it('knows Cloudflare’s, by its page or by the header it sends', () => {
    expect(robotCheck({ status: 403, html: CLOUDFLARE })).toEqual({ by: 'Cloudflare' });
    expect(robotCheck({ status: 403, html: '', headers: { 'cf-mitigated': 'challenge' } })).toEqual(
      { by: 'Cloudflare' },
    );
  });

  it('knows the other common ones', () => {
    const short = (body: string) =>
      robotCheck({ status: 403, html: `<html><body>${body}</body></html>` });
    expect(short('<title>Sucuri WebSite Firewall - Access Denied</title>')?.by).toBe('Sucuri');
    expect(short('Access denied by Imunify360 bot-protection.')?.by).toBe('Imunify360');
    expect(short('Your access to this site has been limited by the site owner')?.by).toBe(
      'Wordfence',
    );
    expect(
      robotCheck({ status: 405, html: '', headers: { 'x-amzn-waf-action': 'captcha' } })?.by,
    ).toBe('Amazon Web Services');
  });

  it('never takes a real page for one, even one that mentions a check service', () => {
    expect(robotCheck({ status: 200, html: TERMS })).toBeNull();
    const post = `<html><body><article>${'<p>We moved our site to SiteGround and put Cloudflare in front of it; here is what we learned about Sucuri and Imunify360 along the way.</p>'.repeat(15)}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></article></body></html>`;
    expect(robotCheck({ status: 200, html: post })).toBeNull();
  });

  it('leaves a page with no words of its own, and no check, to the reader’s own refusal', () => {
    expect(
      robotCheck({ status: 200, html: '<html><body><div id="app"></div></body></html>' }),
    ).toBeNull();
    expect(robotCheck({ status: null, html: '' })).toBeNull();
  });

  it('says who showed it and why, in a sentence', () => {
    expect(robotCheckWhy({ by: 'SiteGround' })).toBe(
      'Your website’s security (SiteGround) does this to keep bots out. People opening the page in a browser get past it.',
    );
    expect(robotCheckWhy({ by: null })).toMatch(/^Your website’s security does this/);
  });
});
