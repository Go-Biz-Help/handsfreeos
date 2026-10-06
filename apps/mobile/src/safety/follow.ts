import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { SAFETY_PHONE_WORDS } from '@hfos/core';

import type { Answer } from '@/changes/rules';
import { sendCommand, type CommandRequest } from '@/changes/send';
import { appVersion } from '@/lib/app-version';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { deviceStore } from '@/lib/device-store';
import { appFetch, networkSnapshot, subscribeNetwork } from '@/lib/network';

/**
 * A check-in follows the phone (round seven, core; Chris 2026-10-05). With Share where I am on, checking in starts
 * location updates that stop when the check-in ends: checked out here, answered from the reminder, or ended anywhere
 * else (the phone's copy says so, `reconcileFollowing`). iPhone keeps them going with its blue location pill and
 * Android with a notification, both under the "while using the app" permission: no "always", and Android's background
 * location stays blocked (app.json).
 *
 * Each update sends `safety.where` straight away rather than through the queue of changes, because only the latest
 * spot matters: with no signal it waits on this phone, replaced by the next, and goes when signal is back. The server
 * keeps one spot per check-in, the latest by when it was taken, ignores one that arrives after the check-in ended, and
 * says so: the phone stops then, even with no screen open.
 */

export const FOLLOW_TASK = 'hfos-safety-follow';
/** How often, at most, the phone says where it is while following, and how far it has to move between. */
export const FOLLOW_EVERY_MS = 2 * 60_000;
export const FOLLOW_EVERY_METERS = 100;

const FOLLOWING_KEY = 'safety.following';
const LATEST_KEY = 'safety.following.latest';

export interface Following {
  readonly workspaceId: string;
  readonly checkInId: string;
}

export interface Spot extends Following {
  readonly latitude: number;
  readonly longitude: number;
  /** When the phone took it (its own clock; the API corrects it). */
  readonly at: number;
}

interface Store {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export interface FollowDeps {
  readonly store: Store;
  /** Starts the phone's location updates for this task, with the words its notification shows. */
  readonly startUpdates: (place: string) => Promise<void>;
  readonly stopUpdates: () => Promise<void>;
  readonly send: (request: CommandRequest) => Promise<Answer>;
  readonly newId: () => string;
}

export const deviceFollowDeps: FollowDeps = {
  store: deviceStore,
  startUpdates: (place) =>
    Location.startLocationUpdatesAsync(FOLLOW_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: FOLLOW_EVERY_MS,
      distanceInterval: FOLLOW_EVERY_METERS,
      deferredUpdatesInterval: FOLLOW_EVERY_MS,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.Other,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: SAFETY_PHONE_WORDS.followingTitle,
        notificationBody: SAFETY_PHONE_WORDS.followingBody(place),
        killServiceOnDestroy: false,
      },
    }),
  stopUpdates: async () => {
    if (await TaskManager.isTaskRegisteredAsync(FOLLOW_TASK))
      await Location.stopLocationUpdatesAsync(FOLLOW_TASK);
  },
  send: (request) =>
    sendCommand(
      {
        apiUrl: config.apiUrl,
        fetch: appFetch,
        token: () => session.accessToken(),
        appVersion,
        now: Date.now,
      },
      request,
    ),
  newId: () => Crypto.randomUUID(),
};

/** The check-in this phone follows, if any. */
export function following(deps: Pick<FollowDeps, 'store'> = deviceFollowDeps): Following | null {
  return deps.store.get<Following>(FOLLOWING_KEY) ?? null;
}

/**
 * Starts following a check-in just made with a first reading. False when the phone wouldn't (its location turned
 * off since, or the system refused): the check-in still stands, with the spot it started with.
 */
export async function startFollowing(
  c: Following & { readonly place: string },
  deps: FollowDeps = deviceFollowDeps,
): Promise<boolean> {
  deps.store.set(FOLLOWING_KEY, { workspaceId: c.workspaceId, checkInId: c.checkInId });
  deps.store.remove(LATEST_KEY);
  try {
    await deps.startUpdates(c.place);
    return true;
  } catch {
    deps.store.remove(FOLLOWING_KEY);
    return false;
  }
}

/** Stops following: this check-in only when one is named, any otherwise. A spot still waiting goes with it. */
export async function stopFollowing(
  checkInId?: string,
  deps: FollowDeps = deviceFollowDeps,
): Promise<void> {
  const now = following(deps);
  if (checkInId && now && now.checkInId !== checkInId) return;
  deps.store.remove(FOLLOWING_KEY);
  deps.store.remove(LATEST_KEY);
  await deps.stopUpdates().catch(() => {});
}

/**
 * The phone's copy of a business says which of the person's check-ins there are still open: following one of them
 * that isn't (checked out on another phone, or answered by the business) stops.
 */
export async function reconcileFollowing(
  workspaceId: string,
  openCheckInIds: readonly string[],
  deps: FollowDeps = deviceFollowDeps,
): Promise<void> {
  const now = following(deps);
  if (now && now.workspaceId === workspaceId && !openCheckInIds.includes(now.checkInId))
    await stopFollowing(now.checkInId, deps);
}

/** `safety.where` answering that the check-in has ended. */
const endedIn = (body: unknown) =>
  !!body && typeof body === 'object' && (body as { open?: unknown }).open === false;

/**
 * Sends the latest spot waiting, if any. Kept for later when nothing came back (no signal), or when HandsFreeOS hasn't
 * heard of the check-in yet (made with no signal, it's still waiting in the queue); dropped once answered. The answer
 * saying the check-in has ended, or a refusal saying it doesn't share or isn't this person's, stops following.
 */
export async function sendLatest(deps: FollowDeps = deviceFollowDeps): Promise<void> {
  const spot = deps.store.get<Spot>(LATEST_KEY);
  if (!spot) return;
  const answer = await deps.send({
    name: 'safety.where',
    commandId: deps.newId(),
    input: JSON.stringify({
      workspaceId: spot.workspaceId,
      checkInId: spot.checkInId,
      latitude: spot.latitude,
      longitude: spot.longitude,
    }),
    madeAt: new Date(spot.at).toISOString(),
    confirmedAt: null,
  });
  if (!answer.reached || answer.status === 404) return;
  const latest = deps.store.get<Spot>(LATEST_KEY);
  if (latest && latest.at === spot.at) deps.store.remove(LATEST_KEY);
  if (answer.status === 403 || answer.status === 409 || endedIn(answer.body))
    await stopFollowing(spot.checkInId, deps);
}

/** What the task hears: the readings since the last time, oldest first. Only the newest is kept and sent. */
export async function onLocations(
  locations: readonly Location.LocationObject[],
  deps: FollowDeps = deviceFollowDeps,
): Promise<void> {
  const now = following(deps);
  if (!now) {
    // Updates nobody is following any more (a check-out the system didn't hear in time): stop them.
    await deps.stopUpdates().catch(() => {});
    return;
  }
  const last = locations[locations.length - 1];
  if (!last) return;
  const waiting = deps.store.get<Spot>(LATEST_KEY);
  if (!waiting || waiting.at < last.timestamp)
    deps.store.set(LATEST_KEY, {
      ...now,
      latitude: last.coords.latitude,
      longitude: last.coords.longitude,
      at: last.timestamp,
    } satisfies Spot);
  await sendLatest(deps);
}

let watching = false;

/** Signal back: a spot taken with none goes now, rather than at the next one (a phone that stays put sends none). */
export function watchFollowing(deps: FollowDeps = deviceFollowDeps): void {
  if (watching) return;
  watching = true;
  subscribeNetwork(() => {
    if (networkSnapshot().online && following(deps)) void sendLatest(deps).catch(() => {});
  });
}
