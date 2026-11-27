/**
 * The customer's pages in the brand kit (design tools, part 7; docs/forms.md, "The customer's pages"): the kit's font
 * and corners as the page draws them, and whether the footer has anything to say. No database.
 */
import { describe, expect, it } from 'vitest';
import { FORM_DEFAULT_FONT } from '../../src/look/fonts';
import {
  footerHasAny,
  pageKitOf,
  websiteShown,
  type CustomerFooter,
} from '../../src/look/page-kit';

const EMPTY: CustomerFooter = {
  license: null,
  address: [],
  phone: null,
  website: null,
  socials: [],
};

describe('the kit on a customer’s page', () => {
  it('changes nothing for a kit with no font or corners, or HandsFreeOS’s own', () => {
    expect(pageKitOf(null)).toEqual({ vars: {}, fontHref: null });
    expect(pageKitOf({ font: null, corners: null })).toEqual({ vars: {}, fontHref: null });
    expect(pageKitOf({ font: FORM_DEFAULT_FONT, corners: 'slight' })).toEqual({
      vars: {},
      fontHref: null,
    });
  });

  it('sets the radius tokens for square or round corners', () => {
    expect(pageKitOf({ corners: 'square' }).vars).toEqual({
      '--radius-control': '0px',
      '--radius-menu': '0px',
      '--radius-card': '0px',
    });
    expect(pageKitOf({ corners: 'round' }).vars['--radius-control']).toBe('22px');
  });

  it('draws in the kit’s font, with where the browser gets it', () => {
    const kit = pageKitOf({ font: 'Playfair Display' });
    expect(kit.vars['--kit-font']).toMatch(/^'Playfair Display', Georgia/);
    expect(kit.fontHref).toMatch(
      /^https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display.*&display=swap$/,
    );
    // A font Match my website found, not one of ours: asked for with no weights.
    expect(pageKitOf({ font: 'Some Sans' }).fontHref).toBe(
      'https://fonts.googleapis.com/css2?family=Some+Sans&display=swap',
    );
  });
});

describe('the footer', () => {
  it('is drawn only when it has something to say', () => {
    expect(footerHasAny(null)).toBe(false);
    expect(footerHasAny(EMPTY)).toBe(false);
    expect(footerHasAny({ ...EMPTY, license: 'Lic. 1' })).toBe(true);
    expect(footerHasAny({ ...EMPTY, address: ['1 Main St'] })).toBe(true);
    expect(footerHasAny({ ...EMPTY, phone: '(512) 555-0134' })).toBe(true);
    expect(footerHasAny({ ...EMPTY, website: 'https://acme.com' })).toBe(true);
    expect(
      footerHasAny({ ...EMPTY, socials: [{ kind: 'facebook', url: 'https://facebook.com/a' }] }),
    ).toBe(true);
  });

  it('shows a website without its https://, www. or last slash', () => {
    expect(websiteShown('https://www.acmeplumbing.com/')).toBe('acmeplumbing.com');
    expect(websiteShown('http://acme.com/services')).toBe('acme.com/services');
  });
});
