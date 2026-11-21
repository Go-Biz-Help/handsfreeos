/**
 * Admin → Try onboarding's "From an offer link" (20261027027500): what the website's and an affiliate's links carry to
 * the sign-up (`?plan=`, `?code=`, `?ref=`, `?business=`, `?industry=`), read off the practice sign-up the same way the
 * real one reads them, and carried on to the setup's first screen and the plan page in the address. The real sign-up
 * keeps the code and the affiliate on the new account; a practice one keeps nothing, so they ride along instead, and
 * nobody is credited.
 */
import { findIndustry, PRACTICE_WORDS as W } from '@hfos/core';
import {
  affiliateTrail,
  discountCode,
  websiteBusiness,
  websiteBusinessQuery,
} from './auth/visitor';
import { wantedPlan } from './founding-plan';

type Query = Record<string, string | string[] | undefined>;

export interface PracticeLink {
  readonly plan: 'yearly' | 'monthly' | null;
  readonly code: string | null;
  readonly ref: string | null;
  readonly business: ReturnType<typeof websiteBusiness>;
  /** What rides on to the next page: the plan, the code and the website's business. */
  readonly onward: string;
  /** What the link carried, in words, for the sign-up's note; empty for a plain link. */
  readonly words: readonly string[];
}

export function practiceLinkOf(query: Query): PracticeLink {
  const plan = wantedPlan(query.plan);
  const code = discountCode(query.code) ?? null;
  const ref = affiliateTrail(query.ref, null)?.ref ?? null;
  const business = websiteBusiness(query.business, query.industry);
  const onward = new URLSearchParams({
    ...(plan ? { plan } : {}),
    ...(code ? { code } : {}),
    ...websiteBusinessQuery(business),
  }).toString();
  const kind = business.industry ? findIndustry(business.industry)?.label : undefined;
  const words = [
    ...(plan ? [W.linkNotePlan(W.linkPlans[plan])] : []),
    ...(code ? [W.linkNoteCode(code)] : []),
    ...(ref ? [W.linkNoteRef(ref)] : []),
    ...(business.name
      ? [W.linkNoteBusiness(kind ? `${business.name}, ${kind}` : business.name)]
      : []),
  ];
  return { plan, code, ref, business, onward: onward ? `?${onward}` : '', words };
}
