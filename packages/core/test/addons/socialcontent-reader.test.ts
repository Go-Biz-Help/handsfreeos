/**
 * AI Social Media Content Creator's reading computer checking in (docs/socialcontent.md, "What it's doing"): the
 * computer asks for work twice a minute, round the clock, and when it last did is written once it's due, not on
 * every ask (the speed audit, Nov 2026: every ask rewrote the business's settings row). No database.
 */
import { describe, expect, it } from 'vitest';
import { READER_SEEN_EVERY_MS, readerSeenDue } from '../../src/addons/socialcontent/ops/reading';
import { READER_THERE_MS } from '../../src/addons/socialcontent/words';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const kept = (agoMs: number | null, version: string | null = '0.152.0') => ({
  readerSeenAt: agoMs === null ? null : new Date(NOW - agoMs).toISOString(),
  readerVersion: version,
});

describe('when the reading computer’s check-in is written', () => {
  it('is the first time, and then once what’s kept is 2 minutes old', () => {
    expect(readerSeenDue(kept(null, null), '0.152.0', NOW)).toBe(true);
    expect(readerSeenDue(kept(30_000), '0.152.0', NOW)).toBe(false);
    expect(readerSeenDue(kept(READER_SEEN_EVERY_MS - 1), '0.152.0', NOW)).toBe(false);
    expect(readerSeenDue(kept(READER_SEEN_EVERY_MS), '0.152.0', NOW)).toBe(true);
  });

  it('is at once for a new version of the extension, and not for an ask that names none', () => {
    expect(readerSeenDue(kept(30_000), '0.153.0', NOW)).toBe(true);
    expect(readerSeenDue(kept(30_000), undefined, NOW)).toBe(false);
    expect(readerSeenDue(kept(30_000, null), null, NOW)).toBe(false);
  });

  it('is often enough that the page never calls a computer that’s there quiet', () => {
    // It asks each minute, so what's kept is 3 minutes old at most; the page waits READER_THERE_MS to say "last".
    expect(READER_SEEN_EVERY_MS + 60_000).toBeLessThan(READER_THERE_MS / 2);
  });
});
