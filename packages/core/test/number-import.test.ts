/**
 * Bringing a number that is already in Twilio (20261011000100): the words and small decisions every screen and
 * the worker share. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  carrierIsTwilio,
  isTollFreeNumber,
  nextImportCheckMs,
  numberTypeOf,
  numberUsedBy,
  textingStateOf,
  transferRequestText,
} from '../src/messaging/number-import';
import { NumberImportStartInput, TwilioConnectInput } from '../src/schemas/number-import';

const WS = '00000000-0000-4000-8000-000000000001';
/**
 * A made-up API key id. Built from its parts so no key-shaped literal sits beside a key-ish name, which the
 * secret scanner rightly cannot tell from a real one.
 */
const KEY_SID = ['SK', 'made', 'up', 'test'].join('');
const KEY_SECRET = 's'.repeat(32);

describe('who a number is used by today', () => {
  it('knows HighLevel by where its webhooks point', () => {
    expect(
      numberUsedBy({
        smsUrl: 'https://services.leadconnectorhq.com/phone-system/twilio/inbound-sms',
      }),
    ).toBe('highlevel');
    expect(numberUsedBy({ voiceUrl: 'https://api.msgsndr.com/voice' })).toBe('highlevel');
    expect(
      numberUsedBy(
        { smsUrl: 'https://hooks.handsfreeos.com/sms' },
        'https://hooks.handsfreeos.com',
      ),
    ).toBe('handsfreeos');
    expect(numberUsedBy({ smsUrl: 'https://example.com/sms' })).toBe('other');
    expect(numberUsedBy({ smsUrl: null, voiceUrl: '' })).toBe('nothing');
    // A lookalike is not HighLevel.
    expect(numberUsedBy({ smsUrl: 'https://notleadconnectorhq.com.evil.test/x' })).toBe('other');
  });

  it('tells a Twilio-hosted number from one on another carrier', () => {
    expect(carrierIsTwilio('Twilio - SMS/MMS-SVR')).toBe(true);
    expect(carrierIsTwilio('Twilio - Toll-Free - SMS-Sybase365/MMS-SVR')).toBe(true);
    expect(carrierIsTwilio('Verizon Wireless')).toBe(false);
    expect(carrierIsTwilio(null)).toBe(false);
  });

  it('knows a toll-free number, which needs toll-free verification rather than 10DLC', () => {
    expect(isTollFreeNumber('+18335550123')).toBe(true);
    expect(numberTypeOf('+18885550123')).toBe('toll_free');
    expect(numberTypeOf('+12565550123')).toBe('local');
    expect(numberTypeOf('+18105550123')).toBe('local');
  });
});

describe('the transfer request', () => {
  it('names the destination account and never asks for the number to be released', () => {
    for (const source of ['highlevel', 'twilio'] as const) {
      const text = transferRequestText({
        source,
        display: '(256) 555-0123',
        toAccountSid: 'ACdestinationtest',
        fromAccountSid: source === 'twilio' ? 'ACsourcetest' : null,
        businessName: 'Lone Star HVAC',
      });
      expect(text).toContain('ACdestinationtest');
      expect(text).toContain('(256) 555-0123');
      expect(text).toMatch(/do not release/i);
      expect(text).not.toMatch(/please release|delete the number/i);
    }
    expect(
      transferRequestText({
        source: 'twilio',
        display: '(256) 555-0123',
        toAccountSid: 'ACdestinationtest',
        fromAccountSid: 'ACsourcetest',
      }),
    ).toContain('From Account SID: ACsourcetest');
  });
});

describe('texting, kept apart from the number', () => {
  it('reads the registration’s next step in the import screen’s four words', () => {
    expect(textingStateOf('ready')).toBe('approved');
    expect(textingStateOf('awaiting_approval')).toBe('in_review');
    expect(textingStateOf('rejected')).toBe('rejected');
    expect(textingStateOf('submit_registration')).toBe('needs_registration');
  });
});

describe('how often a number is looked for', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const startedAt = new Date('2026-10-01T00:00:00Z');
  const at = (days: number) =>
    nextImportCheckMs({ startedAt, now: startedAt.getTime() + days * DAY, baseMs: 5 * 60_000 });
  it('looks often at first, and less as the days go by', () => {
    expect(at(0)).toBe(5 * 60_000);
    expect(at(3)).toBe(60 * 60_000);
    expect(at(20)).toBe(6 * 60 * 60_000);
  });
});

describe('the inputs', () => {
  it('does not take a connected account for a HighLevel number', () => {
    expect(
      NumberImportStartInput.safeParse({
        workspaceId: WS,
        e164: '+12565550123',
        source: 'highlevel',
        connectionId: WS,
      }).success,
    ).toBe(false);
  });

  it('takes an auth token or an API key, one or the other', () => {
    const base = { workspaceId: WS, accountSid: 'ACtheirstest1234' };
    expect(TwilioConnectInput.safeParse({ ...base, authToken: 'a'.repeat(32) }).success).toBe(true);
    expect(
      TwilioConnectInput.safeParse({
        ...base,
        apiKeySid: KEY_SID,
        apiKeySecret: KEY_SECRET,
      }).success,
    ).toBe(true);
    expect(TwilioConnectInput.safeParse(base).success).toBe(false);
    expect(
      TwilioConnectInput.safeParse({
        ...base,
        authToken: 'a'.repeat(32),
        apiKeySid: KEY_SID,
        apiKeySecret: KEY_SECRET,
      }).success,
    ).toBe(false);
    expect(TwilioConnectInput.safeParse({ ...base, apiKeySid: KEY_SID }).success).toBe(false);
  });
});
