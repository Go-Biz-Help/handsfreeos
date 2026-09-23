/**
 * M18 step 3, without a database: which of a customer's photos the teammate looks at, what its turn says about
 * the rest, and that a reply to a photo says a price only where the owner lets it give ranges.
 */
import { emptyKnowledgeProfile, parseTeammateConfig, applyTeammatePatch } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import type { BatchMessage, PhotoRef, RunContext } from '../src/ai-team/context';
import { photoLines, pickPhotos } from '../src/ai-team/photos';
import { checkReply } from '../src/ai-team/run';
import { newRunState } from '../src/ai-team/tools';

const photo = (name: string, contentType = 'image/jpeg', sizeBytes = 200_000): PhotoRef => ({
  bucket: 'telephony',
  objectPath: `ws/messages/m/${name}`,
  contentType,
  sizeBytes,
});
const msg = (photos: PhotoRef[]): BatchMessage => ({
  id: crypto.randomUUID(),
  channel: 'sms',
  text: '(sent photos)',
  subject: null,
  at: Date.now(),
  photos,
});

describe('which photos it looks at', () => {
  it('takes the newest three it can open, and counts the rest', () => {
    const pick = pickPhotos([
      msg([photo('1.jpg'), photo('2.heic', 'image/heic')]),
      msg([photo('3.png', 'image/png'), photo('4.jpg'), photo('5.jpg', 'image/jpeg', 9_000_000)]),
      msg([photo('6.webp', 'image/webp')]),
    ]);
    expect(pick.shown.map((p) => p.objectPath.split('/').pop())).toEqual([
      '3.png',
      '4.jpg',
      '6.webp',
    ]);
    expect(pick).toMatchObject({ unreadable: 1, tooBig: 1, more: 1 });
    const lines = photoLines(pick, 3).join('\n');
    expect(lines).toContain('Their 3 newest photos are below');
    expect(lines).toContain('1 more you can’t see');
    expect(lines).toContain('can’t open');
    expect(lines).toContain('too big');
  });

  it('says nothing when there are no photos', () => {
    expect(photoLines(pickPhotos([msg([])]), 0)).toEqual([]);
  });
});

describe('prices in a reply to a photo', () => {
  const rcWith = (priceRanges: boolean) => {
    const profile = { ...emptyKnowledgeProfile(), allowPrices: true };
    return {
      config: applyTeammatePatch(parseTeammateConfig({}), { photos: { priceRanges } }),
      grounding: { profile, business: { name: 'Lone Star HVAC' } },
      conversation: { id: null, channel: 'sms', counterpart: null, personId: null },
      firstAiMessage: false,
      batch: [msg([photo('1.jpg')])],
      allowed: { domains: [], urlPrefixes: [], phones: [], emails: [] },
      matches: [
        {
          id: 'k1',
          title: 'Sizing guide',
          body: 'A 3-ton system replacement runs $4,000 to $6,500.',
        },
      ],
    } as unknown as RunContext;
  };
  const reply =
    'From the photo it looks like a 3-ton unit: usually $4,000 to $6,500. The team confirms after a look.';

  it('refuses a price when ranges from photos are off', () => {
    const state = { ...newRunState(), photos: 1 };
    expect(checkReply(rcWith(false), state, reply).ok).toBe(false);
  });

  it('lets a range from Knowledge through when the owner allows ranges', () => {
    const state = { ...newRunState(), photos: 1 };
    expect(checkReply(rcWith(true), state, reply).ok).toBe(true);
  });

  it('keeps the usual price rule when it saw no photo', () => {
    const state = newRunState();
    expect(checkReply(rcWith(false), state, reply).ok).toBe(true);
  });
});
