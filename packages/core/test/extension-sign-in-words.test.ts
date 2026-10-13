/**
 * Approving an extension sign-in with a matching number (20261027002900), the parts that need no database: the
 * numbers offered, the words, and the push that belongs to no business but the person themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_SIGN_IN_WORDS,
  ExtensionSignInCollectOutput,
  extensionSignInNumbers,
  extensionSignInPushWords,
} from '../src/account/extension-sign-in';
import { isPersonalPush, isStaffPush, PERSONAL_PUSH_PATH, PushData } from '../src/push';

/** A seeded stand-in for crypto's randomInt, so a run is repeatable. */
function seeded(seed: number) {
  let s = seed;
  return (below: number) => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s % below;
  };
}

describe('the numbers a sign-in offers', () => {
  it('always offers three different 2-digit numbers, the extension’s among them, anywhere in the row', () => {
    const places = new Set<number>();
    for (let seed = 1; seed < 500; seed += 1) {
      const { number, choices } = extensionSignInNumbers(seeded(seed));
      expect(number).toBeGreaterThanOrEqual(10);
      expect(number).toBeLessThanOrEqual(99);
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(3);
      for (const c of choices) expect(c >= 10 && c <= 99).toBe(true);
      expect(choices).toContain(number);
      places.add(choices.indexOf(number));
    }
    expect([...places].sort()).toEqual([0, 1, 2]);
  });

  it('copes with a random source that keeps answering the same', () => {
    let n = 0;
    const { choices } = extensionSignInNumbers((below) => (n++ < 5 ? 0 : (n * 7) % below));
    expect(new Set(choices).size).toBe(3);
  });
});

describe('the words', () => {
  it('ask about the browser, and say how to start again when it’s gone', () => {
    expect(EXTENSION_SIGN_IN_WORDS.question('Chrome')).toBe(
      'Signing in to the extension on Chrome?',
    );
    expect(EXTENSION_SIGN_IN_WORDS.question('  ')).toBe(
      'Signing in to the extension on your browser?',
    );
    expect(EXTENSION_SIGN_IN_WORDS.pick).toBe('Pick the number you see.');
    expect(EXTENSION_SIGN_IN_WORDS.gone).toMatch(/Send me a prompt/);
    expect(extensionSignInPushWords('Edge').title).toBe('Signing in to the extension on Edge?');
  });

  it('hand the extension a token only with an approval', () => {
    expect(ExtensionSignInCollectOutput.safeParse({ status: 'approved' }).success).toBe(false);
    expect(ExtensionSignInCollectOutput.safeParse({ status: 'waiting' }).success).toBe(true);
    expect(
      ExtensionSignInCollectOutput.safeParse({ status: 'approved', tokenHash: 'abc' }).success,
    ).toBe(true);
  });
});

describe('the sign-in push', () => {
  const ID = '77777777-7777-4777-8777-777777777777';
  const push = (over: Record<string, unknown> = {}) => ({
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000009',
    category: 'extension_sign_in',
    workspaceId: null,
    business: '',
    path: `${PERSONAL_PUSH_PATH}${ID}`,
    sentAt: '2026-10-13T20:00:00.000Z',
    refs: { signInId: ID },
    commandIds: {},
    ...over,
  });

  it('is the person’s own: no business, and it opens its own screen and nowhere else', () => {
    expect(isPersonalPush('extension_sign_in')).toBe(true);
    expect(isStaffPush('extension_sign_in')).toBe(false);
    expect(isPersonalPush('support_ticket')).toBe(false);
    expect(PushData.safeParse(push()).success).toBe(true);
    expect(
      PushData.safeParse(push({ workspaceId: '11111111-1111-4111-8111-111111111111' })).success,
    ).toBe(false);
    expect(PushData.safeParse(push({ path: `/admin/tickets/${ID}` })).success).toBe(false);
    // And no business's push may open it.
    expect(
      PushData.safeParse(
        push({
          category: 'booking',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          business: 'Lone Star',
        }),
      ).success,
    ).toBe(false);
  });
});
