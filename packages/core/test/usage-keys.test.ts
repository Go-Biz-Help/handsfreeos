/**
 * The keys that stop a text being billed twice. Every one of these is a unique index away from being real
 * money, so the cases worth writing down are the ones where the same event arrives twice wearing a different
 * hat: a status callback, a webhook retry, a sweep run again.
 */
import { describe, expect, it } from 'vitest';
import {
  a2pBrandUsageKey,
  a2pBrandVettingUsageKey,
  a2pCampaignMonthUsageKey,
  a2pCampaignVettingUsageKey,
  aiUsageKey,
  assistantUsageKey,
  callLegUsageKey,
  callUsageKey,
  creditUsageKey,
  billingDay,
  mmsUsageKey,
  billingMonth,
  campaignPeriod,
  monthOf,
  numberMonthUsageKey,
  reconcileUsageKey,
  smsUsageKey,
  speechUsageKey,
  topUpUsageKey,
  videoCallUsageKey,
} from '../src/money/usage-keys';

describe('a text', () => {
  it('is one key whatever Twilio calls its status', () => {
    // sent, delivered and undelivered are three callbacks for one message and one charge.
    const sid = 'SM0123456789abcdef0123456789abcdef';
    expect(smsUsageKey(sid)).toBe(`sms:${sid}`);
    expect(smsUsageKey(sid)).toBe(smsUsageKey(sid));
  });

  it('is a different key from a picture message with the same sid', () => {
    expect(smsUsageKey('SMabc')).not.toBe(mmsUsageKey('SMabc'));
  });

  it('refuses to name itself without a sid, rather than charging nothing', () => {
    expect(() => smsUsageKey('')).toThrow(/needs the MessageSid/);
    expect(() => smsUsageKey('   ')).toThrow(/needs the MessageSid/);
  });
});

describe('a call', () => {
  it('counts once however many status callbacks arrive', () => {
    expect(callUsageKey('CA9999')).toBe('call:CA9999');
  });

  it('tells apart the two legs of a call that rang somebody’s own cell', () => {
    // One parent call, two billable legs: the customer's number and the teammate's cell.
    const parent = 'CA9999';
    const customer = callLegUsageKey(parent, '+15125550134');
    const cell = callLegUsageKey(parent, '+15125550199');
    expect(customer).not.toBe(cell);
    expect(customer).not.toBe(callUsageKey(parent));
  });

  it('needs the number a leg dialled, since that is the only thing telling legs apart', () => {
    expect(() => callLegUsageKey('CA9999', '')).toThrow(/number the leg dialled/);
  });
});

describe('a phone number’s month', () => {
  it('charges October once however often the sweep runs', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(numberMonthUsageKey(id, '2026-10')).toBe(`number:${id}:2026-10`);
    expect(numberMonthUsageKey(id, '2026-10-17T09:00:00Z')).toBe(`number:${id}:2026-10`);
  });

  it('is a different key in November', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(numberMonthUsageKey(id, '2026-10')).not.toBe(numberMonthUsageKey(id, '2026-11'));
  });

  it('refuses a month it cannot read, rather than inventing one', () => {
    expect(() => numberMonthUsageKey('n1', 'October')).toThrow(/a month like 2026-09/);
    expect(() => numberMonthUsageKey('n1', '2026')).toThrow(/a month like 2026-09/);
  });
});

describe('the rest', () => {
  it('names an AI request by the row that recorded it', () => {
    expect(aiUsageKey('u1')).toBe('ai:u1');
    expect(assistantUsageKey('r1')).toBe('assistant:r1');
    // An assistant run and an ai_usage row with the same id are different events.
    expect(aiUsageKey('x')).not.toBe(assistantUsageKey('x'));
  });

  it('names a running total of speech by its batch and its price line', () => {
    expect(speechUsageKey('b1', 'speech.voice.kchar')).toBe('speech:b1:speech.voice.kchar');
    // One batch is charged a line per key, so the keys must differ.
    expect(speechUsageKey('b1', 'speech.live.minute')).not.toBe(
      speechUsageKey('b1', 'speech.voice.kchar'),
    );
    expect(() => speechUsageKey('', 'speech.voice.kchar')).toThrow();
  });

  it('names a stretch of a video call by LiveKit’s room, so the closing webhook sent twice counts once', () => {
    expect(videoCallUsageKey('RM_abc123')).toBe('video:RM_abc123');
    expect(videoCallUsageKey('RM_abc123')).not.toBe(videoCallUsageKey('RM_def456'));
    expect(() => videoCallUsageKey('')).toThrow();
  });

  it('names a top-up by the recharge row, which exists before the card is ever charged', () => {
    expect(topUpUsageKey('rc1')).toBe('topup:rc1');
  });

  it('lets a credit carry its own reference, because two credits are two decisions', () => {
    expect(creditUsageKey('ticket-4471')).toBe('credit:ticket-4471');
  });

  it('writes one reconciliation per category per day, so re-running a week writes nothing', () => {
    expect(reconcileUsageKey('sms-outbound', '2026-09-20')).toBe(
      'reconcile:sms-outbound:2026-09-20',
    );
    expect(reconcileUsageKey('sms-outbound', '2026-09-20T23:59:00Z')).toBe(
      'reconcile:sms-outbound:2026-09-20',
    );
  });
});

describe('billingMonth, billingDay and monthOf', () => {
  it('read a month and a day out of an ISO moment', () => {
    expect(billingMonth('2026-09-20T18:04:00Z')).toBe('2026-09');
    expect(billingDay('2026-09-20T18:04:00Z')).toBe('2026-09-20');
  });

  it('say which month a moment falls in where the business is, not where the server is', () => {
    // Half past six on the last evening of September in Texas is already October in UTC.
    const at = Date.parse('2026-10-01T01:30:00Z');
    expect(monthOf(at, 'America/Chicago')).toBe('2026-09');
    expect(monthOf(at, 'UTC')).toBe('2026-10');
  });

  it('refuse what they cannot read', () => {
    expect(() => billingDay('yesterday')).toThrow(/a day like/);
    expect(() => billingMonth('')).toThrow(/a month like/);
  });
});

describe('texting registration fees', () => {
  const brand = 'BN0123456789abcdef0123456789abcdef';
  const campaign = 'QE0123456789abcdef0123456789abcdef';

  it('charges a brand once, by its own sid, however often it is sent again', () => {
    expect(a2pBrandUsageKey(brand)).toBe(`a2p-brand:${brand}`);
    expect(a2pBrandVettingUsageKey(brand)).toBe(`a2p-brand-vetting:${brand}`);
    // The registration and its extra check are two fees for one brand.
    expect(a2pBrandUsageKey(brand)).not.toBe(a2pBrandVettingUsageKey(brand));
    expect(() => a2pBrandUsageKey('')).toThrow(/brand sid/);
  });

  it('charges each campaign review, since a campaign sent again is a new campaign', () => {
    expect(a2pCampaignVettingUsageKey(campaign)).toBe(`a2p-campaign-vetting:${campaign}`);
    expect(a2pCampaignVettingUsageKey(campaign)).not.toBe(a2pCampaignVettingUsageKey('QE2'));
  });

  it('charges a campaign once a month, the month being part of the key', () => {
    expect(a2pCampaignMonthUsageKey(campaign, '2026-10')).toBe(`a2p-campaign:${campaign}:2026-10`);
    expect(a2pCampaignMonthUsageKey(campaign, '2026-10-17T09:00:00Z')).toBe(
      a2pCampaignMonthUsageKey(campaign, '2026-10'),
    );
    expect(a2pCampaignMonthUsageKey(campaign, '2026-10')).not.toBe(
      a2pCampaignMonthUsageKey(campaign, '2026-11'),
    );
  });
});

describe('a campaign’s month', () => {
  const approved = new Date('2026-10-15T14:00:00Z');

  it('starts on the day it was approved, and again on that day each month', () => {
    expect(campaignPeriod(approved, approved)).toEqual({ month: '2026-10', startsAt: approved });
    expect(campaignPeriod(approved, new Date('2026-11-15T13:59:59Z'))?.month).toBe('2026-10');
    expect(campaignPeriod(approved, new Date('2026-11-15T14:00:00Z'))).toEqual({
      month: '2026-11',
      startsAt: new Date('2026-11-15T14:00:00Z'),
    });
    expect(campaignPeriod(approved, new Date('2027-01-20T00:00:00Z'))?.month).toBe('2027-01');
  });

  it('uses the last day of a month that has no such day', () => {
    const lateJanuary = new Date('2027-01-31T10:00:00Z');
    expect(campaignPeriod(lateJanuary, new Date('2027-02-27T23:00:00Z'))?.month).toBe('2027-01');
    expect(campaignPeriod(lateJanuary, new Date('2027-02-28T10:00:00Z'))).toEqual({
      month: '2027-02',
      startsAt: new Date('2027-02-28T10:00:00Z'),
    });
    // March has a 31st, so March's month starts on it rather than on the 28th.
    expect(campaignPeriod(lateJanuary, new Date('2027-03-30T10:00:00Z'))?.month).toBe('2027-02');
    expect(campaignPeriod(lateJanuary, new Date('2027-03-31T10:00:00Z'))?.month).toBe('2027-03');
  });

  it('owes nothing before it is approved', () => {
    expect(campaignPeriod(approved, new Date('2026-10-14T00:00:00Z'))).toBeNull();
    expect(campaignPeriod(new Date('nonsense'), approved)).toBeNull();
  });
});
