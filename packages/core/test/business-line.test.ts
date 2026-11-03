/**
 * Whether a number is a business landline (AI calls, part 5): Twilio's words in ours, what decides it, what's worth
 * asking, and how a call campaign leaves someone out by it.
 */
import { describe, expect, it } from 'vitest';
import {
  businessLineOf,
  callerTypeOf,
  checksLeftOf,
  lineCheckCostWords,
  lineCheckPriceWords,
  lineTypeOf,
  needsCallerName,
  type LineFacts,
} from '../src/automations/index';
import { callSkipReasonOf } from '../src/campaigns/audience';

const facts = (f: Partial<LineFacts> = {}): LineFacts => ({
  lineType: null,
  callerType: null,
  companyNumber: false,
  ...f,
});

describe('what the phone company says', () => {
  it('reads Twilio’s line types', () => {
    expect(lineTypeOf('landline')).toBe('landline');
    expect(lineTypeOf('mobile')).toBe('mobile');
    expect(lineTypeOf('fixedVoip')).toBe('voip');
    expect(lineTypeOf('nonFixedVoip')).toBe('voip');
    expect(lineTypeOf('tollFree')).toBe('toll_free');
    expect(lineTypeOf('pager')).toBe('other');
    expect(lineTypeOf(null)).toBe('unknown');
  });

  it('reads who a number is registered to', () => {
    expect(callerTypeOf('BUSINESS')).toBe('business');
    expect(callerTypeOf('CONSUMER')).toBe('consumer');
    expect(callerTypeOf('UNDETERMINED')).toBe('unknown');
    expect(callerTypeOf(null)).toBe('unknown');
  });
});

describe('a business landline', () => {
  it('is a landline registered to a business, or a company’s number here', () => {
    expect(businessLineOf(facts({ lineType: 'landline', callerType: 'business' }))).toBe(
      'business',
    );
    expect(businessLineOf(facts({ lineType: 'landline', companyNumber: true }))).toBe('business');
    expect(businessLineOf(facts({ lineType: 'landline', callerType: 'consumer' }))).toBe('other');
    expect(businessLineOf(facts({ lineType: 'landline', callerType: 'unknown' }))).toBe('other');
  });

  it('is never a mobile, an internet number or an unknown line, even a company’s', () => {
    for (const lineType of ['mobile', 'voip', 'toll_free', 'other', 'unknown'] as const)
      expect(businessLineOf(facts({ lineType, companyNumber: true })), lineType).toBe('other');
  });

  it('waits on the phone company for what it hasn’t said yet', () => {
    expect(businessLineOf(facts())).toBe('unchecked');
    expect(businessLineOf(facts({ lineType: 'landline' }))).toBe('unchecked');
  });

  it('asks for the caller name only for a landline that isn’t a company’s', () => {
    expect(needsCallerName(facts({ lineType: 'landline' }))).toBe(true);
    expect(needsCallerName(facts({ lineType: 'landline', companyNumber: true }))).toBe(false);
    expect(needsCallerName(facts({ lineType: 'mobile' }))).toBe(false);
    expect(needsCallerName(facts({ lineType: 'landline', callerType: 'consumer' }))).toBe(false);
  });

  it('knows the most that could still be asked (and paid for) about a number', () => {
    expect(checksLeftOf(facts())).toEqual({ lineType: true, callerName: true });
    expect(checksLeftOf(facts({ companyNumber: true }))).toEqual({
      lineType: true,
      callerName: false,
    });
    expect(checksLeftOf(facts({ lineType: 'landline' }))).toEqual({
      lineType: false,
      callerName: true,
    });
    expect(checksLeftOf(facts({ lineType: 'mobile' }))).toEqual({
      lineType: false,
      callerName: false,
    });
  });
});

describe('what checking costs, in words', () => {
  it('names both prices, and the most a campaign’s checks could come to', () => {
    expect(lineCheckPriceWords({ line: 2, owner: 2 })).toBe(
      '$0.02 to check what kind of line a number is, and $0.02 more to check who a landline belongs to',
    );
    expect(lineCheckCostWords({ line: 2, owner: 2, upTo: 1150 })).toBe(
      'Checking costs $0.02 a number, and $0.02 more for a landline: up to $11.50 for these.',
    );
  });
});

describe('who a call campaign leaves out, with business landlines on', () => {
  const none = {
    hasPhone: true,
    callConsent: false,
    calledRecently: false,
    inConversation: false,
    bookedSoon: false,
  };
  it('keeps in someone with no yes until the phone company says it isn’t a business’s', () => {
    expect(callSkipReasonOf({ ...none, line: null })).toBe('no_call_consent');
    expect(callSkipReasonOf({ ...none, line: 'unchecked' })).toBeNull();
    expect(callSkipReasonOf({ ...none, line: 'business' })).toBeNull();
    expect(callSkipReasonOf({ ...none, line: 'other' })).toBe('not_business_landline');
    // The other reasons still count.
    expect(callSkipReasonOf({ ...none, line: 'business', bookedSoon: true })).toBe('booked_soon');
    expect(callSkipReasonOf({ ...none, hasPhone: false, line: 'unchecked' })).toBe('no_phone');
  });
});
