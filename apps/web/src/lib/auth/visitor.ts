import { findIndustry, type IndustryId } from '@hfos/core';

/**
 * Who this person was on handsfreeos.com before they got here: the website adds Opinly's anonymous visitor id to its
 * "Start free" links as `?oa=`. A new account keeps it, whether made with an email or with Google, so the worker can
 * credit the sign-up, and anything bought later, to the article or campaign that brought them
 * (apps/worker/src/opinly.ts). Only something shaped like one of Opinly's ids is kept, and deleting the account clears
 * it with the rest of the sign-in's details.
 */
export function opinlyVisitor(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value) ? value : undefined;
}

/**
 * The affiliate link they came by (20261027014000): the website adds the code and when it was clicked to its sign-up
 * links as `?ref=` and `?ref_at=`, and an affiliate may share the sign-up page with `?ref=` themselves. A new account
 * keeps them as `affiliate_ref` and `affiliate_ref_at`, whether made with an email or with Google, and its first
 * business is credited to that affiliate as it's made (`private.affiliate_note_signup`). A link shared straight to
 * this page counts from when it's opened.
 */
export interface AffiliateTrail {
  readonly ref: string;
  readonly refAt: string;
}

export function affiliateTrail(ref: unknown, at: unknown): AffiliateTrail | undefined {
  const code = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(code)) return undefined;
  const when = typeof at === 'string' ? new Date(at) : null;
  const refAt =
    when && !Number.isNaN(when.getTime()) && when.getTime() <= Date.now() + 60_000
      ? when.toISOString()
      : new Date().toISOString();
  return { ref: code, refAt };
}

/** What a new account keeps of the trail, in its sign-up details. */
export const affiliateTrailData = (trail: AffiliateTrail | undefined): Record<string, string> =>
  trail ? { affiliate_ref: trail.ref, affiliate_ref_at: trail.refAt } : {};

/**
 * A discount or trial code from a code's link (20261027014300): the website hands `?code=` on to its sign-up links,
 * and a new account keeps it as `affiliate_code`, whether made with an email or with Google, for the plan page to fill
 * in. Only something shaped like a code is kept; whether it is one is the plan page's to ask.
 */
export function discountCode(value: unknown): string | undefined {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(code) ? code : undefined;
}

/** What a new account keeps of the code, in its sign-up details. */
export const discountCodeData = (code: string | undefined): Record<string, string> =>
  code ? { affiliate_code: code } : {};

/**
 * The business they typed into the website's "Try it on your business" (apps/site/src/lib/your-business.ts): its
 * sign-up links carry `?business=` and, when one was picked, `?industry=`. They ride along to the guided setup's first
 * screen, which starts filled in with them; nothing is kept on the account, and the person can change either before
 * the business is made. A name is cut to what the business name takes, and a kind only counts when it's on core's
 * list.
 */
export interface WebsiteBusiness {
  readonly name?: string;
  readonly industry?: IndustryId;
}

export function websiteBusiness(name: unknown, industry: unknown): WebsiteBusiness {
  const typed = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const kind = typeof industry === 'string' ? findIndustry(industry) : undefined;
  return {
    ...(typed ? { name: typed } : {}),
    ...(kind ? { industry: kind.id as IndustryId } : {}),
  };
}

/** The same, as the query string the guided setup reads it from. */
export function websiteBusinessQuery(business: WebsiteBusiness): Record<string, string> {
  return {
    ...(business.name ? { business: business.name } : {}),
    ...(business.industry ? { industry: business.industry } : {}),
  };
}
