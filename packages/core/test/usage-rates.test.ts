/**
 * The rate card's arithmetic, and the seeded prices themselves. The second half of this file is the closest
 * thing to a contract with Chris: "at least one and a half times what it costs us" is a promise, and these are
 * the numbers that keep it. A change to the seed that quietly drops a line under 1.5× fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  MARKUP_FLOOR_BP,
  PASS_THROUGH_KEYS,
  SEED_CARD,
  SEED_RATES,
  USAGE_KEYS,
  USAGE_KEY_UNITS,
  isUsageKey,
  priceEvent,
  priceOf,
  realisedMarkup,
  roundedSeconds,
  unitPriceCents,
  type RateCard,
  type UsageKey,
} from '../src/money/rates';

const card = SEED_CARD;

describe('priceOf', () => {
  it('charges what the card says, in cents, from a cost in micros', () => {
    // A local number: $1.15 a month to us, $2.00 to the business.
    expect(priceOf(card, 'number.local.month', 1)).toEqual({
      amountCents: 200,
      costCents: 115,
      markupBp: 17_391,
    });
  });

  it('rounds once for the whole event, not once per segment', () => {
    // Three outbound segments cost 3.27¢ and are charged 6¢. Priced one at a time they would be 2¢ each — 6¢
    // here by luck, but 3 inbound segments would be 2+2+2=6¢ against the 4¢ this gives.
    expect(priceOf(card, 'sms.inbound.segment', 3).amountCents).toBe(4);
    expect(priceOf(card, 'sms.inbound.segment', 1).amountCents * 3).toBe(6);
  });

  it('never charges less than a line’s floor, which is what keeps sub-cent things above cost', () => {
    // One inbound segment costs us 0.83¢. 1.5× of that is 1.2¢, which cents cannot hold; the floor decides.
    const one = priceOf(card, 'sms.inbound.segment', 1);
    expect(one.amountCents).toBe(2);
    expect(one.costCents).toBe(1);
    expect(one.amountCents).toBeGreaterThanOrEqual(1.5 * 0.83);
  });

  it('charges nothing for nothing, and the floor never turns no usage into a charge', () => {
    expect(priceOf(card, 'sms.outbound.segment', 0).amountCents).toBe(0);
    expect(priceOf(card, 'voice.inbound.tollfree.minute', 0).amountCents).toBe(0);
  });

  it('treats a negative or broken quantity as none rather than as money back', () => {
    expect(priceOf(card, 'sms.outbound.segment', -5).amountCents).toBe(0);
    expect(priceOf(card, 'sms.outbound.segment', Number.NaN).amountCents).toBe(0);
    expect(priceOf(card, 'sms.outbound.segment', Number.POSITIVE_INFINITY).amountCents).toBe(0);
  });

  it('says plainly when a key has no line, rather than charging zero for it', () => {
    const missing: RateCard = { version: 9, rates: {} as RateCard['rates'] };
    expect(() => priceOf(missing, 'sms.outbound.segment', 1)).toThrow(/no line for/);
  });
});

describe('priceEvent', () => {
  /**
   * One AI request is one event. Its four token buckets are priced apart and rounded together: rounded apart
   * they would each lose up to half a cent, four times, always in the same direction.
   */
  it('sums an AI request’s four buckets and rounds once', () => {
    // Each bucket is six tenths of a cent on its own: rounded apart every one of them becomes a whole cent.
    const parts = [
      { key: 'ai.cache_read.mtok' as UsageKey, quantity: 0.02 },
      { key: 'ai.cache_write.mtok' as UsageKey, quantity: 0.0016 },
      { key: 'ai.input.mtok' as UsageKey, quantity: 0.002 },
      { key: 'ai.output.mtok' as UsageKey, quantity: 0.0004 },
    ];
    const together = priceEvent(card, parts);
    const apart = parts.reduce((n, p) => n + priceOf(card, p.key, p.quantity).amountCents, 0);
    // 0.6 × 4 = 2.4¢ → 2¢ together; four separate roundings make it 4¢, always in our favour.
    expect(together.amountCents).toBe(2);
    expect(apart).toBe(4);
  });

  it('lands a typical teammate reply near a penny, which is the number a business is shown', () => {
    const reply = priceEvent(card, [
      { key: 'ai.cache_read.mtok', quantity: 0.008 },
      { key: 'ai.input.mtok', quantity: 0.0012 },
      { key: 'ai.output.mtok', quantity: 0.0005 },
    ]);
    expect(reply.amountCents).toBeGreaterThanOrEqual(1);
    expect(reply.amountCents).toBeLessThanOrEqual(2);
  });

  it('records the markup it actually realised, not the one the card asked for', () => {
    // The floor lifted this event above the card's 1.8072×, and the ledger should say so.
    const one = priceOf(card, 'sms.inbound.segment', 1);
    expect(one.markupBp).toBeGreaterThan(18_072);
    // Where nothing rounds, the realised markup is the card's.
    expect(priceOf(card, 'ai.output.mtok', 1).markupBp).toBe(15_000);
  });

  it('skips the parts that were not used', () => {
    const only = priceEvent(card, [
      { key: 'ai.output.mtok', quantity: 1 },
      { key: 'ai.input.mtok', quantity: 0 },
    ]);
    expect(only.amountCents).toBe(1500);
    expect(only.costCents).toBe(1000);
  });
});

describe('roundedSeconds', () => {
  it('bills a part-minute call as a whole one, the way the carrier bills us', () => {
    expect(roundedSeconds(1, 'minute')).toBe(60);
    expect(roundedSeconds(60, 'minute')).toBe(60);
    expect(roundedSeconds(61, 'minute')).toBe(120);
  });

  it('leaves a length alone when the carrier does', () => {
    expect(roundedSeconds(37, 'none')).toBe(37);
    expect(roundedSeconds(7, 'six_seconds')).toBe(12);
    expect(roundedSeconds(-4, 'minute')).toBe(0);
  });
});

describe('the seeded card', () => {
  it('has a line for every key, and no line for anything else', () => {
    expect(Object.keys(SEED_CARD.rates).sort()).toEqual([...USAGE_KEYS].sort());
    expect(SEED_RATES.map((r) => r.key).sort()).toEqual([...USAGE_KEYS].sort());
    expect(new Set(SEED_RATES.map((r) => r.key)).size).toBe(SEED_RATES.length);
  });

  it('gives every line the unit its key names', () => {
    for (const rate of Object.values(SEED_CARD.rates))
      expect(rate.unit, rate.key).toBe(USAGE_KEY_UNITS[rate.key]);
  });

  it('never prices anything below what it costs us — the promise, line by line', () => {
    for (const rate of Object.values(SEED_CARD.rates)) {
      expect(rate.markupBp, rate.key).toBeGreaterThanOrEqual(MARKUP_FLOOR_BP);
      expect(rate.costMicros, rate.key).toBeGreaterThan(0);
    }
  });

  it('charges at least one and a half times cost for one of each thing, but the fees passed on at cost', () => {
    for (const key of USAGE_KEYS.filter((k) => !PASS_THROUGH_KEYS.includes(k))) {
      // Compared in micros: a tenth of a cent in floating point is not a tenth of a cent.
      const chargedMicros = priceOf(SEED_CARD, key, 1).amountCents * 10_000;
      expect(chargedMicros, key).toBeGreaterThanOrEqual(SEED_CARD.rates[key].costMicros * 1.5);
    }
  });

  /** The prices Chris agreed, in the plan's own table. Changing one of these is changing what a customer pays. */
  it('charges the prices in the plan', () => {
    const charged = Object.fromEntries(USAGE_KEYS.map((k) => [k, unitPriceCents(SEED_CARD, k)]));
    expect(charged).toEqual({
      'number.local.month': 200,
      'number.tollfree.month': 350,
      'sms.outbound.segment': 2,
      // 1.5¢ a segment, lifted to 2¢ for a single-segment message by the floor.
      'sms.inbound.segment': 2,
      'mms.outbound.message': 5,
      'mms.inbound.message': 3,
      'voice.outbound.minute': 2,
      'voice.inbound.local.minute': 2,
      // 3.5¢ a minute, lifted to 4¢ for a one-minute call by the floor.
      'voice.inbound.tollfree.minute': 4,
      'ai.input.mtok': 300,
      'ai.output.mtok': 1500,
      'ai.cache_read.mtok': 30,
      'ai.cache_write.mtok': 375,
      // Ask HandsFreeOS, on Claude Opus: 1.5× its own prices (20261027012500).
      'ai.opus.input.mtok': 600,
      'ai.opus.output.mtok': 3000,
      'ai.opus.cache_read.mtok': 30,
      'ai.opus.cache_write.mtok': 750,
      // Speech is billed in running totals; one unit on its own is lifted by the floor.
      'speech.live.minute': 2,
      'speech.recording.minute': 1,
      'speech.voice.kchar': 5,
      // Rime's voices, each at 1.5× its own price (20261027019100): Coda 7.5¢ and Mist 4.5¢ a thousand characters.
      'speech.voice.coda.kchar': 8,
      'speech.voice.mist.kchar': 5,
      // Zoom's transcript of a coached meeting, at 1.5× its Developer Pack credits.
      'speech.meeting.minute': 3,
      // A person's minute in a HandsFreeOS video call is 0.3¢; one minute on its own is lifted by the floor.
      'video.minute': 1,
      'ai.unknown.mtok': 2250,
      // The carriers' texting registration fees, at exactly what Twilio charges us.
      'a2p.brand.registration': 450,
      'a2p.brand.vetting': 4150,
      'a2p.campaign.vetting': 1500,
      'a2p.campaign.month': 1000,
      // Asking the phone company about a number before an AI call with no yes, at 1.5× Twilio Lookup's price.
      'lookup.line_type': 2,
      'lookup.caller_name': 2,
    });
  });

  it('passes the carriers’ texting registration fees on at cost, and nothing else', () => {
    expect([...PASS_THROUGH_KEYS].sort()).toEqual([
      'a2p.brand.registration',
      'a2p.brand.vetting',
      'a2p.campaign.month',
      'a2p.campaign.vetting',
    ]);
    for (const key of PASS_THROUGH_KEYS) {
      expect(SEED_CARD.rates[key].markupBp, key).toBe(MARKUP_FLOOR_BP);
      const priced = priceOf(SEED_CARD, key, 1);
      expect(priced.amountCents, key).toBe(priced.costCents);
    }
    expect(SEED_CARD.rates['a2p.campaign.month'].unit).toBe('month');
    expect(SEED_CARD.rates['a2p.brand.registration'].unit).toBe('fee');
  });

  it('charges speech one and a half times what Deepgram charges, over a running total', () => {
    // An hour of the AI on calls, an hour of recordings turned into words, and 100,000 characters said.
    expect(priceOf(SEED_CARD, 'speech.live.minute', 60).amountCents).toBe(83);
    expect(priceOf(SEED_CARD, 'speech.recording.minute', 60).amountCents).toBe(47);
    expect(priceOf(SEED_CARD, 'speech.voice.kchar', 100).amountCents).toBe(450);
    // The same 100,000 characters in a Rime voice: Coda costs more, Mist the same as Deepgram.
    expect(priceOf(SEED_CARD, 'speech.voice.coda.kchar', 100).amountCents).toBe(750);
    expect(priceOf(SEED_CARD, 'speech.voice.mist.kchar', 100).amountCents).toBe(450);
    // An hour of a coached Zoom meeting: Zoom's 2¢ a minute, at 1.5×.
    expect(priceOf(SEED_CARD, 'speech.meeting.minute', 60).amountCents).toBe(180);
    for (const key of [
      'speech.live.minute',
      'speech.recording.minute',
      'speech.voice.kchar',
      'speech.voice.coda.kchar',
      'speech.voice.mist.kchar',
      'speech.meeting.minute',
    ] as const)
      expect(SEED_CARD.rates[key].markupBp, key).toBe(15_000);
  });

  it('charges a HandsFreeOS video call one and a half times what LiveKit charges, per person', () => {
    // An hour of two people (14a): about 40¢.
    expect(priceOf(SEED_CARD, 'video.minute', 120).amountCents).toBe(36);
    expect(SEED_CARD.rates['video.minute'].markupBp).toBe(15_000);
    expect(SEED_CARD.rates['video.minute'].unit).toBe('minute');
  });

  it('charges each phone company check one and a half times what Twilio Lookup charges', () => {
    // A hundred numbers checked, every one a landline that isn't a company's: $1.20 and $1.50.
    expect(priceOf(SEED_CARD, 'lookup.line_type', 100).amountCents).toBe(120);
    expect(priceOf(SEED_CARD, 'lookup.caller_name', 100).amountCents).toBe(150);
    for (const key of ['lookup.line_type', 'lookup.caller_name'] as const) {
      expect(SEED_CARD.rates[key].markupBp, key).toBe(15_000);
      expect(SEED_CARD.rates[key].unit, key).toBe('fee');
    }
  });

  it('charges the half-cent lines their half cent once there is more than one of them', () => {
    // Where the floor isn't doing the deciding, the card's own price shows through.
    expect(priceOf(SEED_CARD, 'sms.inbound.segment', 10).amountCents).toBe(15);
    expect(priceOf(SEED_CARD, 'voice.inbound.local.minute', 10).amountCents).toBe(15);
    expect(priceOf(SEED_CARD, 'voice.inbound.tollfree.minute', 10).amountCents).toBe(35);
  });

  it('prices the unknown model above every model it knows, so one gets noticed', () => {
    const known = (['ai.input.mtok', 'ai.output.mtok', 'ai.cache_write.mtok'] as const).map((k) =>
      unitPriceCents(SEED_CARD, k),
    );
    for (const price of known)
      expect(unitPriceCents(SEED_CARD, 'ai.unknown.mtok')).toBeGreaterThan(price);
  });

  it('costs a busy month about what the plan says it does', () => {
    // ~900 outbound and ~600 inbound segments, 900 outbound and 600 inbound local minutes, one local number.
    const month =
      priceOf(SEED_CARD, 'sms.outbound.segment', 900).amountCents +
      priceOf(SEED_CARD, 'sms.inbound.segment', 600).amountCents +
      priceOf(SEED_CARD, 'voice.outbound.minute', 900).amountCents +
      priceOf(SEED_CARD, 'voice.inbound.local.minute', 600).amountCents +
      priceOf(SEED_CARD, 'number.local.month', 1).amountCents;
    // The website now says $30–$60 on top of the plan. This is the phone half of it.
    expect(month / 100).toBeGreaterThan(20);
    expect(month / 100).toBeLessThan(60);
  });
});

describe('isUsageKey', () => {
  it('knows its own keys and nothing else', () => {
    expect(isUsageKey('sms.outbound.segment')).toBe(true);
    expect(isUsageKey('voice.transcription')).toBe(false);
    expect(isUsageKey(null)).toBe(false);
    expect(isUsageKey(7)).toBe(false);
  });
});

describe('realisedMarkup', () => {
  it('is what we charged over what we paid, and nothing at all when we paid nothing', () => {
    expect(realisedMarkup(300, 200)).toBe(1.5);
    expect(realisedMarkup(300, 0)).toBeNull();
  });
});
