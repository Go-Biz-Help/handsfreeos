/**
 * The page a 10DLC reviewer opens before approving a campaign.
 *
 * The assertions about the texting section are not style: a reviewer scans a privacy policy for a sentence
 * saying mobile numbers are not shared, and a policy without one is a campaign turned down. The wording
 * around it may be rewritten freely; the clause may not.
 */
import { describe, expect, it } from 'vitest';
import {
  MOBILE_DATA_CLAUSE,
  policyAsText,
  privacyPolicy,
  termsOfService,
  type PolicyBusiness,
} from '../src/messaging/policies';

const BUSINESS: PolicyBusiness = {
  name: 'Lone Star HVAC',
  legalName: 'Lone Star HVAC LLC',
  website: 'https://lonestarhvac.com',
  email: 'hello@lonestarhvac.com',
  phone: '+15125550123',
  address: { line1: '100 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
};
const ON = new Date('2026-09-21T00:00:00Z');

describe('the privacy policy a carrier reads', () => {
  const policy = privacyPolicy(BUSINESS, ON);
  const text = policyAsText(policy);

  it('carries the mobile-data clause close to verbatim', () => {
    expect(text).toContain(MOBILE_DATA_CLAUSE);
  });

  it('says mobile information is not shared for marketing', () => {
    expect(MOBILE_DATA_CLAUSE).toMatch(/not be shared with any third parties/i);
  });

  it('has a section about texting at all, which is what most small sites lack', () => {
    expect(policy.sections.some((s) => /text messages/i.test(s.heading))).toBe(true);
  });

  it('tells the customer how to stop, in the policy and not only in the text', () => {
    expect(text).toMatch(/repl(y|ying) STOP/i);
    expect(text).toMatch(/HELP/);
  });

  it('says consent is never a condition of buying', () => {
    expect(text).toMatch(/never a condition|not a condition/i);
  });

  it('names the legal entity and how to reach it', () => {
    expect(text).toContain('Lone Star HVAC LLC');
    expect(text).toContain('hello@lonestarhvac.com');
    expect(text).toContain('100 Main St, Austin, TX 78701');
  });

  it('is dated, so a reviewer can see it is current', () => {
    expect(policy.updated).toBe('2026-09-21');
    expect(text).toContain('Last updated: 2026-09-21');
  });

  it('renders the same page twice for the same business', () => {
    expect(policyAsText(privacyPolicy(BUSINESS, ON))).toBe(text);
  });
});

describe('the terms beside it', () => {
  it('repeats the texting disclosures, because a reviewer may open either page', () => {
    const text = policyAsText(termsOfService(BUSINESS, ON));
    expect(text).toMatch(/not a condition/i);
    expect(text).toMatch(/rates may apply/i);
    expect(text).toMatch(/STOP/);
  });
});

describe('a business that has given us less', () => {
  it('still produces a policy, leaving out what it does not know', () => {
    const text = policyAsText(privacyPolicy({ name: 'Dale Plumbing' }, ON));
    expect(text).toContain('Dale Plumbing');
    expect(text).toContain(MOBILE_DATA_CLAUSE);
    expect(text).not.toMatch(/undefined|null/);
  });
});
