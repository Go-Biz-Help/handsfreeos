/**
 * What each kind of event is charged as (M16, step 3). These are the decisions that turn a carrier's webhook
 * into money, and getting one wrong is not a rounding error — it is the difference between a 1.5× margin and a
 * loss that nobody notices for a month.
 *
 * No database: a fake `WalletDeps` records what `chargeUsage` was asked to write, and the assertions are about
 * the parts and the idempotency key. The ledger's own rules have their own tests in packages/db.
 */
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SEED_CARD, priceEvent } from '@hfos/core/server';
import {
  callRateKey,
  chargeAi,
  chargeCall,
  chargeCallLeg,
  chargeText,
  minutesOf,
} from '../src/money/usage-capture';
import * as wallet from '../src/money/wallet';
import type { TenantScope } from '../src/services';

const scope: TenantScope = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
};
const deps: wallet.WalletDeps = {
  db: null as never,
  log: pino({ level: 'silent' }),
  mode: 'shadow',
};

/** Catches what the funnel was asked to charge, and answers as though it wrote the row. */
function watch() {
  const asked: wallet.ChargeInput[] = [];
  vi.spyOn(wallet, 'rateCard').mockResolvedValue(SEED_CARD);
  vi.spyOn(wallet, 'chargeUsage').mockImplementation(async (_d, _s, input) => {
    asked.push(input);
    const priced = priceEvent(SEED_CARD, input.parts);
    return {
      recorded: true,
      amountCents: priced.amountCents,
      costCents: priced.costCents,
      balanceAfterCents: 0,
      crossed: null,
    };
  });
  return asked;
}

describe('a text', () => {
  it('is charged on sent, on delivered and on undelivered — and always onto one row', async () => {
    // Twilio bills us for all three, and the sid is what collapses them onto the row the first one made.
    for (const status of ['sent', 'delivered', 'undelivered']) {
      const asked = watch();
      await chargeText(deps, scope, {
        messageSid: 'SM1',
        direction: 'outbound',
        status,
        segments: 2,
        mediaCount: 0,
        counterpart: '+15125550134',
      });
      expect(asked, status).toHaveLength(1);
      expect(asked[0]!.idempotencyKey).toBe('sms:SM1');
      expect(asked[0]!.parts).toEqual([{ key: 'sms.outbound.segment', quantity: 2 }]);
      vi.restoreAllMocks();
    }
  });

  it('is not charged for a status the carrier does not bill', async () => {
    for (const status of ['queued', 'sending', 'failed']) {
      const asked = watch();
      await chargeText(deps, scope, {
        messageSid: 'SM2',
        direction: 'outbound',
        status,
        segments: 1,
        mediaCount: 0,
        counterpart: '+15125550134',
      });
      expect(asked, status).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it('is charged once on arrival when it came in, with no status to wait for', async () => {
    const asked = watch();
    await chargeText(deps, scope, {
      messageSid: 'SM3',
      direction: 'inbound',
      segments: 3,
      mediaCount: 0,
      counterpart: '+15125550134',
    });
    expect(asked[0]!.parts).toEqual([{ key: 'sms.inbound.segment', quantity: 3 }]);
    // Three segments together are 4c; charged one at a time they would be 6c.
    expect(priceEvent(SEED_CARD, asked[0]!.parts).amountCents).toBe(4);
    vi.restoreAllMocks();
  });

  /**
   * A message with a picture on it is one MMS and not also N segments. Twilio bills the picture and the words
   * ride along with it, so charging both would be charging twice for one message.
   */
  it('with a picture is one picture message, not a picture and its words', async () => {
    const asked = watch();
    await chargeText(deps, scope, {
      messageSid: 'SM4',
      direction: 'outbound',
      status: 'delivered',
      segments: 4,
      mediaCount: 1,
      counterpart: '+15125550134',
    });
    expect(asked[0]!.parts).toEqual([{ key: 'mms.outbound.message', quantity: 1 }]);
    expect(asked[0]!.idempotencyKey).toBe('mms:SM4');
    vi.restoreAllMocks();
  });

  it('is never charged for fewer than one segment, whatever the carrier reported', async () => {
    const asked = watch();
    await chargeText(deps, scope, {
      messageSid: 'SM5',
      direction: 'inbound',
      segments: 0,
      mediaCount: 0,
      counterpart: '+15125550134',
    });
    expect(asked[0]!.parts).toEqual([{ key: 'sms.inbound.segment', quantity: 1 }]);
    vi.restoreAllMocks();
  });

  it('says who it was to or from, in words a person reads on their statement', async () => {
    const asked = watch();
    await chargeText(deps, scope, {
      messageSid: 'SM6',
      direction: 'outbound',
      status: 'sent',
      segments: 1,
      mediaCount: 0,
      counterpart: '+15125550134',
    });
    expect(asked[0]!.subject).toBe('Text to (512) 555-0134');
    vi.restoreAllMocks();
  });
});

describe('a call', () => {
  it('is billed per whole minute, the way the carrier bills us', async () => {
    const asked = watch();
    await chargeCall(deps, scope, {
      callSid: 'CA1',
      direction: 'inbound',
      seconds: 20,
      numberKind: 'local',
      counterpart: '+15125550134',
    });
    // Twenty seconds is a minute to Twilio, so it is a minute to the business.
    expect(asked[0]!.parts).toEqual([{ key: 'voice.inbound.local.minute', quantity: 1 }]);
    expect(asked[0]!.idempotencyKey).toBe('call:CA1');
    vi.restoreAllMocks();
  });

  it('costs more coming in to a toll-free number, which is what it costs us', async () => {
    expect(callRateKey('inbound', 'tollfree')).toBe('voice.inbound.tollfree.minute');
    expect(callRateKey('inbound', 'local')).toBe('voice.inbound.local.minute');
    // An outbound call is an outbound call whichever of our numbers it went out on.
    expect(callRateKey('outbound', 'tollfree')).toBe('voice.outbound.minute');
  });

  it('is not charged when nobody picked up, because the carrier does not charge us either', async () => {
    const asked = watch();
    await chargeCall(deps, scope, {
      callSid: 'CA2',
      direction: 'inbound',
      seconds: 0,
      numberKind: 'local',
      counterpart: '+15125550134',
    });
    expect(asked).toHaveLength(0);
    vi.restoreAllMocks();
  });

  /**
   * Chris's forwarding case. A customer rings the business, the business's number rings somebody's cell, and
   * Twilio bills both: the leg that came in and the leg we dialled out.
   */
  it('put through to somebody’s cell is a second charge, at the outbound rate', async () => {
    const asked = watch();
    await chargeCallLeg(deps, scope, {
      parentCallSid: 'CA3',
      toE164: '+15125550199',
      seconds: 130,
    });
    expect(asked[0]!.parts).toEqual([{ key: 'voice.outbound.minute', quantity: 3 }]);
    // Keyed on the number the leg dialled, so two legs of one call are two rows and one leg is never two.
    expect(asked[0]!.idempotencyKey).toBe('call-leg:CA3:+15125550199');
    vi.restoreAllMocks();
  });
});

describe('an AI request', () => {
  it('prices its four buckets apart and rounds them together', async () => {
    const asked = watch();
    await chargeAi(deps, scope, {
      tokens: {
        inputTokens: 1200,
        outputTokens: 500,
        cacheReadTokens: 8000,
        cacheWriteTokens: 0,
      },
      idempotencyKey: 'ai:u1',
      subject: 'An AI teammate reply',
      known: true,
    });
    expect(asked[0]!.parts).toEqual([
      { key: 'ai.input.mtok', quantity: 0.0012 },
      { key: 'ai.output.mtok', quantity: 0.0005 },
      { key: 'ai.cache_read.mtok', quantity: 0.008 },
      { key: 'ai.cache_write.mtok', quantity: 0 },
    ]);
    // The number a business is shown for a reply: about a penny.
    expect(priceEvent(SEED_CARD, asked[0]!.parts).amountCents).toBe(1);
    vi.restoreAllMocks();
  });

  it('bills a model nobody has priced at the dear unknown rate, not at nothing', async () => {
    const asked = watch();
    await chargeAi(deps, scope, {
      tokens: { inputTokens: 1000, outputTokens: 1000 },
      idempotencyKey: 'ai:u2',
      subject: 'AI in a workflow',
      known: false,
      model: 'some-new-model',
    });
    expect(asked[0]!.parts).toEqual([{ key: 'ai.unknown.mtok', quantity: 0.002 }]);
    expect(priceEvent(SEED_CARD, asked[0]!.parts).amountCents).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });

  it('never charges for tokens that are not there', async () => {
    const asked = watch();
    await chargeAi(deps, scope, {
      tokens: {},
      idempotencyKey: 'ai:u3',
      subject: 'AI in a workflow',
      known: true,
    });
    expect(priceEvent(SEED_CARD, asked[0]!.parts).amountCents).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('minutesOf', () => {
  it('rounds the way the card says the carrier rounds', () => {
    expect(minutesOf(SEED_CARD, 'voice.outbound.minute', 1)).toBe(1);
    expect(minutesOf(SEED_CARD, 'voice.outbound.minute', 61)).toBe(2);
    expect(minutesOf(SEED_CARD, 'voice.outbound.minute', null)).toBe(0);
  });
});
