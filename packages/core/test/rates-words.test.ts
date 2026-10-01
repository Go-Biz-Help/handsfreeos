/**
 * The margin warning on the support desk's rate card: a line charging under the floor is somebody's job today,
 * except the carriers' registration fees, which are passed on at cost on purpose.
 */
import { describe, expect, it } from 'vitest';
import { RATE_MARGIN_FLOOR, rateIsThin, rateThinWarning } from '../src/support/rates-words';

const line = (key: string, markup: number | null) => ({
  key,
  realised: markup === null ? null : { markup },
});

describe('a thin line', () => {
  it('is one charging under the floor, and never one nothing happened on', () => {
    expect(rateIsThin(line('sms.outbound.segment', RATE_MARGIN_FLOOR - 0.1))).toBe(true);
    expect(rateIsThin(line('sms.outbound.segment', 1.5))).toBe(false);
    expect(rateIsThin(line('sms.outbound.segment', null))).toBe(false);
  });

  it('is a registration fee only when it charges under cost', () => {
    expect(rateIsThin(line('a2p.brand.registration', 1))).toBe(false);
    expect(rateIsThin(line('a2p.campaign.month', 1))).toBe(false);
    expect(rateIsThin(line('a2p.campaign.vetting', 0.9))).toBe(true);
  });

  it('names only the thin lines in the warning', () => {
    expect(
      rateThinWarning([line('a2p.brand.vetting', 1), line('sms.outbound.segment', 1.5)]),
    ).toBeNull();
    expect(rateThinWarning([line('voice.outbound.minute', 1.1)])).toContain(
      'voice.outbound.minute',
    );
  });
});
