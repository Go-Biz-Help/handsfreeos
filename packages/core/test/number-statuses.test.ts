/**
 * M17: the two meanings `LIVE_NUMBER_STATUSES` used to carry at once.
 *
 * This is the subtlest correctness point in the phase and it needs no database to get wrong, so it is tested
 * where it can actually be run. While a number could only ever be bought, "claimed by this business" and "can
 * send right now" were the same set and one constant was honest. `porting` is both claimed and unable to send
 * a thing, and whichever single meaning the old constant had kept would have been wrong somewhere:
 *
 *   claimed only   a business could make a number the default that sends nothing
 *   sendable only  two businesses could send the same number to the carrier
 *
 * The SQL says the same thing twice, in the two partial indexes that 0080 rebuilt — `phone_numbers_live_e164`
 * over the claimed set, `phone_numbers_one_default` over the sendable one. If either list here stops matching
 * its index, this file is where it should be noticed.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAIMED_STATUSES,
  LIVE_NUMBER_STATUSES,
  SENDABLE_STATUSES,
  readiness,
} from '../src/messaging/store';

describe('claimed and sendable are different sets', () => {
  it('claims a number that is on its way to us', () => {
    expect(CLAIMED_STATUSES).toContain('porting');
  });

  it('refuses to let it send', () => {
    expect(SENDABLE_STATUSES).not.toContain('porting');
  });

  it('claims everything that can send', () => {
    // A number that can send is, necessarily, one this business holds. The other way round is not true, which
    // is the whole point of there being two lists.
    for (const s of SENDABLE_STATUSES) expect(CLAIMED_STATUSES).toContain(s);
  });

  it('holds neither a released nor a failed number', () => {
    for (const list of [CLAIMED_STATUSES, SENDABLE_STATUSES]) {
      expect(list).not.toContain('released');
      expect(list).not.toContain('failed');
    }
  });

  it('keeps the old name meaning what its callers meant by it', () => {
    // Every use of LIVE_NUMBER_STATUSES that existed before porting meant "can send": it gated the default,
    // the texting check and the ceiling. The deprecated alias has to keep meaning that, or renaming it later
    // would quietly change behaviour at call sites nobody edited.
    expect(LIVE_NUMBER_STATUSES).toEqual(SENDABLE_STATUSES);
  });
});

describe('what the setup screen says while a number is moving to us', () => {
  const approved = [
    { kind: 'a2p_customer_profile', status: 'approved' },
    { kind: 'a2p_trust_product', status: 'approved' },
    { kind: 'a2p_brand', status: 'approved' },
    { kind: 'a2p_campaign', status: 'approved' },
  ];

  it('is its own waiting state, not "setting up"', () => {
    // Both are "claimed, nothing working yet", but one is minutes with us and the other is weeks with a
    // carrier who may still say no. A business waiting three weeks should not be reading "Setting up".
    expect(readiness({ status: 'porting', numberType: 'local' }, [])).toEqual({
      voiceReady: false,
      messagingReady: false,
      nextStep: 'porting',
    });
  });

  it('says nothing works yet even with the whole registration chain approved', () => {
    // The registration is about being allowed to text at all; this number is not ours yet. Approving the
    // chain early is normal and must not make the screen claim texting works.
    expect(readiness({ status: 'porting', numberType: 'local' }, approved)).toMatchObject({
      voiceReady: false,
      messagingReady: false,
      nextStep: 'porting',
    });
  });

  it('turns into an ordinary ready number the moment it lands', () => {
    expect(readiness({ status: 'active', numberType: 'local' }, approved)).toEqual({
      voiceReady: true,
      messagingReady: true,
      nextStep: 'ready',
    });
  });
});
