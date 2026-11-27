/**
 * The customer's pages in the brand kit (design tools, part 7; HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md,
 * decision 10): their invoice, estimate, payment plan, document to sign and appointment follow the kit's font, corners
 * and colour, and end with a footer of the business's license number, address, phone, website and social links.
 * Browser-safe: the worker fills the footer (`customerFooterOf`, server side), the web draws both.
 */
import { CORNER_RADII } from '../forms/design';
import { fontStackOf, formFontHref } from './fonts';
import type { LookCorners, LookSocialLink } from './look';

/** What the bottom of a customer's page says about the business. */
export interface CustomerFooter {
  /** As the business writes it, like "TX HVAC Lic. TACLA12345C". */
  readonly license: string | null;
  /** Its postal address, a line each. */
  readonly address: readonly string[];
  /** As shown, like (512) 555-0134. */
  readonly phone: string | null;
  readonly website: string | null;
  readonly socials: readonly LookSocialLink[];
}

/** Whether a footer has anything to say: one with nothing in it isn't drawn. */
export const footerHasAny = (f: CustomerFooter | null | undefined): f is CustomerFooter =>
  !!f && (!!f.license || f.address.length > 0 || !!f.phone || !!f.website || f.socials.length > 0);

/** A website as the footer shows it: no https://, no www., no slash at the end. */
export const websiteShown = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

/**
 * The brand kit's font and corners as a customer's page draws them: the radius tokens and the font, as CSS custom
 * properties for the page's frame, and where the browser gets the font. Nothing for a kit that has neither, so the
 * page looks as it always has.
 */
export function pageKitOf(
  kit: { readonly font?: string | null; readonly corners?: LookCorners | null } | null | undefined,
): { vars: Record<string, string>; fontHref: string | null } {
  const vars: Record<string, string> = {};
  if (kit?.corners && kit.corners !== 'slight') {
    const r = CORNER_RADII[kit.corners];
    vars['--radius-control'] = r.control;
    vars['--radius-menu'] = r.menu;
    vars['--radius-card'] = r.card;
  }
  const stack = fontStackOf(kit?.font);
  if (stack) vars['--kit-font'] = stack;
  return { vars, fontHref: formFontHref(kit?.font) };
}
