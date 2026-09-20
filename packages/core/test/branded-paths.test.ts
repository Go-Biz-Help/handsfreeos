/**
 * M17: what a business's own domain serves.
 *
 * The rule is small and the cost of getting it wrong is not: one wrong arm and either a customer's link
 * 404s on the name printed on the van, or — much worse — a HandsFreeOS sign-in form is served on somebody
 * else's domain, which is a phishing page we built ourselves.
 */
import { describe, expect, it } from 'vitest';
import { brandedRoute } from '../src/hosting/branded-paths';

const SITE = 'lonestar';

describe('brandedRoute', () => {
  it('serves the booking page at the root, which is the point of the whole feature', () => {
    expect(brandedRoute(SITE, '/')).toEqual({ kind: 'rewrite', path: '/book/lonestar' });
  });

  it('serves a bare name as that business’s form', () => {
    expect(brandedRoute(SITE, '/quote')).toEqual({ kind: 'rewrite', path: '/f/lonestar/quote' });
    expect(brandedRoute(SITE, '/new-ac-install')).toEqual({
      kind: 'rewrite',
      path: '/f/lonestar/new-ac-install',
    });
  });

  it('leaves every link we have already sent exactly as it was sent', () => {
    for (const path of [
      '/book/lonestar',
      '/book/lonestar/tune-up',
      '/f/lonestar/quote',
      '/e/AbCd1234EfGh567890',
      '/i/AbCd1234EfGh567890',
      '/p/AbCd1234EfGh567890',
      '/m/AbCd1234EfGh567890',
      '/w/AbCd1234EfGh567890',
      '/hold/AbCd1234EfGh567890',
      '/chat/pk_live_abc',
      '/embed/v1/pk_live_abc.js',
    ])
      expect(brandedRoute(SITE, path), path).toEqual({ kind: 'serve' });
  });

  it('does not mistake a prefix for a form name', () => {
    // `/book` is a bare name by shape. Read as one it would serve a form called "book" and the business's
    // own booking page would 404 on its own domain.
    expect(brandedRoute(SITE, '/book')).toEqual({ kind: 'serve' });
    expect(brandedRoute(SITE, '/f')).toEqual({ kind: 'serve' });
    expect(brandedRoute(SITE, '/chat')).toEqual({ kind: 'serve' });
  });

  it('never serves the app, sign-in or the admin side on a business’s name', () => {
    for (const path of [
      '/app',
      '/app/w/123/inbox',
      '/sign-in',
      '/sign-up',
      '/auth/callback',
      '/admin',
      '/admin/businesses',
      '/invite/abc',
      '/support-invite/abc',
      '/api/anything',
    ])
      expect(brandedRoute(SITE, path), path).toEqual({ kind: 'elsewhere' });
  });

  it('sends anything it does not recognise away rather than guessing', () => {
    // A route added later appears on our own address first, and on a business's domain only once somebody
    // has decided it should. Silence is the safe default here.
    expect(brandedRoute(SITE, '/quote/thanks')).toEqual({ kind: 'elsewhere' });
    expect(brandedRoute(SITE, '/a/b/c')).toEqual({ kind: 'elsewhere' });
    expect(brandedRoute(SITE, '/-nope')).toEqual({ kind: 'elsewhere' });
    expect(brandedRoute(SITE, '/nope-')).toEqual({ kind: 'elsewhere' });
  });
});
