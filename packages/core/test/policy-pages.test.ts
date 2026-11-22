/**
 * Where a website's own privacy policy and terms are, told from the addresses a walk of the site came across (texting
 * approval's question on the policy and terms; the owner's pick 10a, 2026-11-22). A page found here is picked for the
 * business and read by itself, so the tests hold what must never be taken for a policy as closely as what is one.
 */
import { describe, expect, it } from 'vitest';
import {
  policyPagesAmong,
  policyPagesSummary,
  samePolicyPage,
} from '../src/messaging/policy-pages';

const SITE = 'https://lonestarhvac.com';
const among = (...paths: string[]) => policyPagesAmong(paths.map((p) => `${SITE}${p}`));

describe('finding the privacy policy and the terms among a site’s pages', () => {
  it('knows them by how sites name these pages', () => {
    expect(among('/', '/services', '/privacy-policy', '/terms-of-service', '/contact')).toEqual({
      privacy: `${SITE}/privacy-policy`,
      terms: `${SITE}/terms-of-service`,
    });
    for (const path of [
      '/privacy',
      '/Privacy-Policy/',
      '/legal/privacy.html',
      '/privacy_notice',
      '/our-privacy-policy',
      '/privacy-statement.php',
      '/cookie-and-privacy-policy',
    ])
      expect(among(path).privacy, path).toBe(`${SITE}${path}`);
    for (const path of [
      '/terms',
      '/tos',
      '/terms-and-conditions',
      '/Terms-Of-Use/',
      '/legal/terms.html',
      '/conditions-of-use',
      '/terms-of-sale',
      '/user-agreement',
      '/general-terms-and-conditions',
    ])
      expect(among(path).terms, path).toBe(`${SITE}${path}`);
  });

  it('one page can be both', () => {
    expect(among('/privacy-and-terms')).toEqual({
      privacy: `${SITE}/privacy-and-terms`,
      terms: `${SITE}/privacy-and-terms`,
    });
  });

  it('doesn’t take a page about something else for one', () => {
    expect(
      among(
        '/',
        '/blog/why-privacy-matters',
        '/privacy-fence-installation',
        '/services/privacy-glass',
        // What a clinic treats, and what a lender offers.
        '/conditions',
        '/conditions-we-treat',
        '/loan-terms-explained',
        '/short-term-rentals',
        '/service',
        '/services',
        '/user',
        '/agreement',
        // The folder is named for it, the page isn't.
        '/privacy/contact',
        '/terms/2019/archive',
      ),
    ).toEqual({ privacy: null, terms: null });
  });

  it('takes the shallowest, then the shortest, and the first seen when they tie', () => {
    expect(
      among('/es/privacy', '/legal/privacy-policy', '/privacy-policy', '/privacy').privacy,
    ).toBe(`${SITE}/privacy`);
    expect(among('/en/terms', '/fr/terms').terms).toBe(`${SITE}/en/terms`);
  });

  it('reads past what isn’t an address', () => {
    expect(policyPagesAmong(['not an address', '', `${SITE}/%E0%A4%A`, `${SITE}/privacy`])).toEqual(
      {
        privacy: `${SITE}/privacy`,
        terms: null,
      },
    );
  });
});

describe('whether two addresses are the same page', () => {
  it('however each was typed', () => {
    expect(
      samePolicyPage('lonestarhvac.com/privacy', 'https://www.lonestarhvac.com/privacy/'),
    ).toBe(true);
    expect(
      samePolicyPage('HTTP://LoneStarHVAC.com/privacy', 'https://lonestarhvac.com/privacy'),
    ).toBe(true);
    expect(samePolicyPage(' https://lonestarhvac.com ', 'lonestarhvac.com/')).toBe(true);
  });

  it('not for another page, or for none', () => {
    expect(samePolicyPage('lonestarhvac.com/privacy', 'lonestarhvac.com/privacy-policy')).toBe(
      false,
    );
    expect(samePolicyPage('lonestarhvac.com/privacy', 'lonestarhvac.com/Privacy')).toBe(false);
    expect(
      samePolicyPage('lonestarhvac.com/legal?doc=privacy', 'lonestarhvac.com/legal?doc=terms'),
    ).toBe(false);
    expect(samePolicyPage('', '')).toBe(false);
    expect(samePolicyPage(null, 'lonestarhvac.com/privacy')).toBe(false);
    expect(samePolicyPage('lonestarhvac.com/privacy', undefined)).toBe(false);
  });
});

describe('what the look found, in words', () => {
  const privacy = `${SITE}/privacy`;
  const terms = `${SITE}/terms`;

  it('says which are the business’s own and which we wrote', () => {
    expect(policyPagesSummary({ privacy, terms }, 'lonestarhvac.com')).toMatch(
      /^We found your privacy policy and your terms on lonestarhvac\.com, so we’re using yours\./,
    );
    const onlyPrivacy = policyPagesSummary({ privacy, terms: null }, 'lonestarhvac.com');
    expect(onlyPrivacy).toMatch(/^We found your privacy policy on lonestarhvac\.com/);
    expect(onlyPrivacy).toMatch(/We didn’t find terms there, so we wrote those for you\.$/);
    const onlyTerms = policyPagesSummary({ privacy: null, terms }, 'lonestarhvac.com');
    expect(onlyTerms).toMatch(/^We found your terms on lonestarhvac\.com/);
    expect(onlyTerms).toMatch(/We didn’t find a privacy policy there, so we wrote one for you\.$/);
  });

  it('with neither, says we wrote both and how to give theirs', () => {
    const none = policyPagesSummary({ privacy: null, terms: null }, 'lonestarhvac.com');
    expect(none).toMatch(/^We didn’t find a privacy policy or terms on lonestarhvac\.com/);
    expect(none).toContain('“I already have my own”');
  });
});
