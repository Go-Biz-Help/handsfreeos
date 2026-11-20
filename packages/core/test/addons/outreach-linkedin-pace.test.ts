/**
 * LinkedIn's profiles read, slower (decision 182, the owner, 20 Nov 2026): never more than its 40 a day, even on a day
 * the goal needs more good fits, a minute or two apart, a few at a time. LinkedIn showed its security check 2 minutes
 * after 42 profiles read 15 to 30 seconds apart, on a day of 98 (19 Nov 2026). The other networks keep their way.
 */
import { describe, expect, it } from 'vitest';
import { CHECK_PACE_SECONDS, checkPaceOf, checksBatchOf } from '../../src/addons/outreach/checks';
import { NETWORKS } from '../../src/addons/outreach/networks';
import { readsPerDay } from '../../src/addons/outreach/ops/checks';

describe('LinkedIn’s profiles read', () => {
  it('stays at 40 a day on a day the goal needs more good fits, and halves after a warning', () => {
    expect(NETWORKS.linkedin.checksMost).toBe(NETWORKS.linkedin.checksPerDay);
    expect(readsPerDay('linkedin', false, false)).toBe(40);
    expect(readsPerDay('linkedin', false, true)).toBe(40);
    expect(readsPerDay('linkedin', true, false)).toBe(20);
  });

  it('goes a minute or two apart, 10 at a time', () => {
    expect(checkPaceOf('linkedin')).toEqual([60, 120]);
    expect(checksBatchOf('linkedin')).toBe(10);
  });

  it('leaves the other networks as they were', () => {
    expect(readsPerDay('facebook', false, true)).toBe(NETWORKS.facebook.checksMost);
    for (const platform of ['facebook', 'instagram', 'alignable', 'threads', 'x'] as const) {
      expect(checkPaceOf(platform)).toEqual(CHECK_PACE_SECONDS);
      expect(checksBatchOf(platform)).toBeNull();
    }
  });
});
