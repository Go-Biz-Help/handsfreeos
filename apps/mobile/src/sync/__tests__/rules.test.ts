import type { SyncStatus } from '@powersync/common';

import { businessCopyOf } from '../business-copy';
import {
  KEPT_TTL_S,
  LOCK_AFTER_DAYS,
  OPEN_TTL_S,
  beforeOpening,
  copyLocked,
  onSignOut,
  wantedBusinesses,
} from '../rules';
import {
  BusinessSubscriptions,
  readBusinessSubscriptions,
  type BusinessStreams,
} from '../subscriptions';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-16T15:00:00Z');

describe('time to live', () => {
  it('keeps a kept business for 30 days without renewal, the same as the lock, and an open one for 10 minutes', () => {
    expect(KEPT_TTL_S).toBe(30 * 24 * 60 * 60);
    expect(KEPT_TTL_S * 1000).toBe(LOCK_AFTER_DAYS * DAY_MS);
    expect(OPEN_TTL_S).toBe(10 * 60);
    // PowerSync's own default is a day, which is neither.
    expect([KEPT_TTL_S, OPEN_TTL_S]).not.toContain(24 * 60 * 60);
  });

  it('wants every kept business, and the open one while there’s signal or it’s already held', () => {
    const wanted = (open: string | null, online: boolean, held: string[] = []) =>
      Object.fromEntries(wantedBusinesses({ kept: ['ls', 'bp'], open, online, held }));
    expect(wanted(null, true)).toEqual({ ls: KEPT_TTL_S, bp: KEPT_TTL_S });
    expect(wanted('ls', true)).toEqual({ ls: KEPT_TTL_S, bp: KEPT_TTL_S });
    expect(wanted('sr', true)).toEqual({ ls: KEPT_TTL_S, bp: KEPT_TTL_S, sr: OPEN_TTL_S });
    expect(wanted('sr', false)).toEqual({ ls: KEPT_TTL_S, bp: KEPT_TTL_S });
    expect(wanted('sr', false, ['sr'])).toEqual({ ls: KEPT_TTL_S, bp: KEPT_TTL_S, sr: OPEN_TTL_S });
  });
});

describe('the subscriptions', () => {
  function streams(existing: { businessId: string; expiresAt: Date | null }[] = []) {
    const calls: string[] = [];
    const fake: BusinessStreams = {
      subscribe: async (id, ttl) => {
        calls.push(`subscribe ${id} ${ttl}`);
        return { unsubscribe: () => calls.push(`release ${id}`) };
      },
      subscribed: async () => existing,
    };
    return { fake, calls };
  }

  it('subscribes once per business and time to live, and lets go of what isn’t wanted', async () => {
    const { fake, calls } = streams();
    const subs = new BusinessSubscriptions(fake, () => NOW);
    await subs.apply(new Map([['ls', KEPT_TTL_S]]));
    await subs.apply(new Map([['ls', KEPT_TTL_S]]));
    expect(calls).toEqual([`subscribe ls ${KEPT_TTL_S}`]);
    await subs.apply(new Map([['sr', OPEN_TTL_S]]));
    expect(calls.slice(1)).toEqual([
      `subscribe sr ${OPEN_TTL_S}`,
      `subscribe ls ${OPEN_TTL_S}`,
      'release ls',
      'release ls',
    ]);
    expect(Object.fromEntries(subs.holding())).toEqual({ sr: OPEN_TTL_S });
    subs.releaseAll();
    expect(calls.at(-1)).toBe('release sr');
  });

  it('shortens a subscription left from before that nothing renews, and leaves short ones alone', async () => {
    const { fake, calls } = streams([
      { businessId: 'gone', expiresAt: new Date(NOW + 20 * DAY_MS) },
      { businessId: 'leaving', expiresAt: new Date(NOW + 5 * 60 * 1000) },
      { businessId: 'ls', expiresAt: new Date(NOW + 30 * DAY_MS) },
    ]);
    await new BusinessSubscriptions(fake, () => NOW).apply(new Map([['ls', KEPT_TTL_S]]));
    expect(calls).toEqual([
      `subscribe ls ${KEPT_TTL_S}`,
      `subscribe gone ${OPEN_TTL_S}`,
      'release gone',
    ]);
  });
});

describe('reading the subscriptions', () => {
  it('reads each business and when it runs out from PowerSync’s table, in microseconds', async () => {
    const getAll = jest.fn(async () => [
      { local_params: '{"workspace_id":"ls"}', expires_at: NOW * 1000 },
      { local_params: '{"workspace_id":"sr"}', expires_at: null },
      { local_params: 'null', expires_at: NOW * 1000 },
    ]);
    await expect(readBusinessSubscriptions({ getAll } as never)).resolves.toEqual([
      { businessId: 'ls', expiresAt: new Date(NOW) },
      { businessId: 'sr', expiresAt: null },
    ]);
    expect(getAll).toHaveBeenCalledWith(expect.stringContaining('ps_stream_subscriptions'), [
      'business_v1',
    ]);
  });
});

describe('wiping and locking', () => {
  it('deletes on sign-out only when nothing is waiting', () => {
    expect(onSignOut(0)).toBe('delete');
    expect(onSignOut(1)).toBe('keep');
  });

  it('deletes everyone else’s copy and key before a person’s copy opens, and replaces their own key with no copy for it', () => {
    expect(
      beforeOpening({
        userId: 'marco',
        peopleWithCopies: ['dale', 'marco'],
        peopleWithKeys: ['dale', 'priya', 'marco'],
        ownKeyFound: true,
      }),
    ).toEqual({ deleteCopiesOf: ['dale'], replaceKeysOf: ['dale', 'priya'], newOwnKey: false });
    expect(
      beforeOpening({ userId: 'dale', peopleWithCopies: [], peopleWithKeys: [], ownKeyFound: true })
        .newOwnKey,
    ).toBe(true);
    expect(
      beforeOpening({
        userId: 'dale',
        peopleWithCopies: ['dale'],
        peopleWithKeys: [],
        ownKeyFound: false,
      }).newOwnKey,
    ).toBe(true);
  });

  it('locks a copy whose last completed sync is more than 30 days old, and never one that hasn’t finished its first', () => {
    expect(copyLocked(new Date(NOW - 29 * DAY_MS), NOW)).toBe(false);
    expect(copyLocked(new Date(NOW - 30 * DAY_MS), NOW)).toBe(false);
    expect(copyLocked(new Date(NOW - 30 * DAY_MS - 1), NOW)).toBe(true);
    expect(copyLocked(new Date(NOW - 31 * DAY_MS), NOW)).toBe(true);
    expect(copyLocked(undefined, NOW)).toBe(false);
    expect(copyLocked(null, NOW)).toBe(false);
  });
});

describe('a business’s copy', () => {
  const status = (
    streams: Record<string, { hasSynced: boolean; fraction?: number }>,
    lastSyncedAt?: Date,
  ) =>
    ({
      lastSyncedAt,
      forStream: ({ parameters }: { parameters: { workspace_id: string } }) => {
        const s = streams[parameters.workspace_id];
        return s
          ? {
              subscription: { hasSynced: s.hasSynced },
              progress:
                s.fraction === undefined
                  ? null
                  : {
                      downloadedFraction: s.fraction,
                      totalOperations: 100,
                      downloadedOperations: 0,
                    },
            }
          : undefined;
      },
    }) as unknown as SyncStatus;

  it('shows how far its first copy has got, and is complete once it has synced', () => {
    expect(businessCopyOf(status({ ls: { hasSynced: false, fraction: 0.4 } }), 'ls', NOW)).toEqual({
      complete: false,
      percent: 40,
      locked: false,
    });
    expect(businessCopyOf(status({ ls: { hasSynced: false } }), 'ls', NOW).percent).toBeNull();
    expect(
      businessCopyOf(status({ ls: { hasSynced: false, fraction: 1 } }), 'ls', NOW).percent,
    ).toBe(99);
    expect(businessCopyOf(status({ ls: { hasSynced: true, fraction: 0.5 } }), 'ls', NOW)).toEqual({
      complete: true,
      percent: null,
      locked: false,
    });
    expect(businessCopyOf(status({}), 'ls', NOW).complete).toBe(false);
    expect(businessCopyOf(null, 'ls', NOW).complete).toBe(false);
  });

  it('is locked when the whole copy hasn’t synced in 30 days', () => {
    expect(
      businessCopyOf(status({ ls: { hasSynced: true } }, new Date(NOW - 31 * DAY_MS)), 'ls', NOW)
        .locked,
    ).toBe(true);
  });
});
