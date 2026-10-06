import type { LocationObject } from 'expo-location';

import type { Answer } from '@/changes/rules';
import type { CommandRequest } from '@/changes/send';

import {
  following,
  onLocations,
  reconcileFollowing,
  sendLatest,
  startFollowing,
  stopFollowing,
  type FollowDeps,
} from '../follow';

/**
 * A check-in follows the phone (round seven): checking in with Share where I am on starts location updates, each
 * sends only the latest spot (waiting on the phone with no signal), and the check-in ending anywhere stops them: here,
 * from the answer to a spot, or from the phone's copy.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECK_IN = '66666666-6666-4666-8666-666666666666';
const T0 = Date.parse('2026-10-05T18:00:00.000Z');

const reading = (latitude: number, longitude: number, at: number): LocationObject => ({
  coords: {
    latitude,
    longitude,
    altitude: null,
    accuracy: 20,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: at,
});

function phone(answers: Answer[] = []) {
  const values = new Map<string, unknown>();
  const sent: CommandRequest[] = [];
  const updates = { started: [] as string[], stopped: 0 };
  let n = 0;
  const deps: FollowDeps = {
    store: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key, value) => void values.set(key, value),
      remove: (key) => void values.delete(key),
    },
    startUpdates: async (place) => void updates.started.push(place),
    stopUpdates: async () => void updates.stopped++,
    send: async (request) => {
      sent.push(request);
      return (
        answers.shift() ?? {
          reached: true,
          status: 200,
          body: { checkInId: CHECK_IN, kept: true, open: true },
        }
      );
    },
    newId: () => `cmd-${++n}`,
  };
  const spots = () =>
    sent.map((r) => ({
      ...(JSON.parse(r.input) as { latitude: number; longitude: number }),
      madeAt: r.madeAt,
    }));
  return { deps, sent, spots, updates, values };
}

const start = (deps: FollowDeps) =>
  startFollowing({ workspaceId: WS, checkInId: CHECK_IN, place: '2207 Juniper Trail' }, deps);

describe('following a check-in', () => {
  it('starts with the place in its notification, and sends the newest reading it hears', async () => {
    const p = phone();
    expect(await start(p.deps)).toBe(true);
    expect(p.updates.started).toEqual(['2207 Juniper Trail']);
    expect(following(p.deps)).toEqual({ workspaceId: WS, checkInId: CHECK_IN });

    await onLocations([reading(30.21, -97.79, T0), reading(30.25, -97.75, T0 + 60_000)], p.deps);
    expect(p.spots()).toEqual([
      {
        workspaceId: WS,
        checkInId: CHECK_IN,
        latitude: 30.25,
        longitude: -97.75,
        madeAt: new Date(T0 + 60_000).toISOString(),
      },
    ]);
    expect(p.sent[0]!.name).toBe('safety.where');
    expect(p.values.has('safety.following.latest')).toBe(false);
  });

  it('keeps the latest spot with no signal, replaced by the next, and sends it when there is', async () => {
    const offline: Answer = { reached: false, message: 'No signal.' };
    const p = phone([offline, offline, offline]);
    await start(p.deps);
    await onLocations([reading(30.21, -97.79, T0)], p.deps);
    await onLocations([reading(30.3, -97.7, T0 + 120_000)], p.deps);
    // An older reading heard late doesn't replace a newer one waiting.
    await onLocations([reading(30.29, -97.71, T0 + 60_000)], p.deps);
    await sendLatest(p.deps);
    expect(p.spots().map((s) => s.latitude)).toEqual([30.21, 30.3, 30.3, 30.3]);
    expect(p.spots().at(-1)!.madeAt).toBe(new Date(T0 + 120_000).toISOString());
    expect(p.values.has('safety.following.latest')).toBe(false);
    expect(following(p.deps)).not.toBeNull();
  });

  it('holds a spot while HandsFreeOS hasn’t heard of the check-in yet (it was made with no signal)', async () => {
    const p = phone([{ reached: true, status: 404, body: { error: { rule: 'not_found' } } }]);
    await start(p.deps);
    await onLocations([reading(30.21, -97.79, T0)], p.deps);
    expect(following(p.deps)).not.toBeNull();
    await sendLatest(p.deps);
    expect(p.spots()).toHaveLength(2);
    expect(p.values.has('safety.following.latest')).toBe(false);
  });

  it('stops when the answer says the check-in has ended somewhere else', async () => {
    const p = phone([
      { reached: true, status: 200, body: { checkInId: CHECK_IN, kept: false, open: false } },
    ]);
    await start(p.deps);
    await onLocations([reading(30.21, -97.79, T0)], p.deps);
    expect(following(p.deps)).toBeNull();
    expect(p.updates.stopped).toBe(1);
  });

  it('stops when the check-in doesn’t share where the phone is', async () => {
    const p = phone([
      { reached: true, status: 409, body: { error: { rule: 'safety_not_shared' } } },
    ]);
    await start(p.deps);
    await onLocations([reading(30.21, -97.79, T0)], p.deps);
    expect(following(p.deps)).toBeNull();
  });

  it('stops updates nobody follows any more, without sending them', async () => {
    const p = phone();
    await onLocations([reading(30.21, -97.79, T0)], p.deps);
    expect(p.sent).toHaveLength(0);
    expect(p.updates.stopped).toBe(1);
  });

  it('says so when the phone wouldn’t start, and follows nothing', async () => {
    const p = phone();
    p.deps = {
      ...p.deps,
      startUpdates: async () => {
        throw new Error('Location is off.');
      },
    } as FollowDeps;
    expect(await startFollowing({ workspaceId: WS, checkInId: CHECK_IN, place: 'x' }, p.deps)).toBe(
      false,
    );
    expect(following(p.deps)).toBeNull();
  });
});

describe('stopping', () => {
  it('stops for its own check-in, and leaves another one alone', async () => {
    const p = phone();
    await start(p.deps);
    await stopFollowing('99999999-9999-4999-8999-999999999999', p.deps);
    expect(following(p.deps)).not.toBeNull();
    await stopFollowing(CHECK_IN, p.deps);
    expect(following(p.deps)).toBeNull();
    expect(p.updates.stopped).toBe(1);
  });

  it('stops when the phone’s copy says the check-in is no longer open, in its own business only', async () => {
    const p = phone();
    await start(p.deps);
    await reconcileFollowing(WS, [CHECK_IN], p.deps);
    await reconcileFollowing(OTHER_WS, [], p.deps);
    expect(following(p.deps)).not.toBeNull();
    await reconcileFollowing(WS, [], p.deps);
    expect(following(p.deps)).toBeNull();
  });
});
