import * as Network from 'expo-network';
import { useSyncExternalStore } from 'react';

import { deviceStore } from './device-store';

/**
 * Whether the phone has signal, as the phone reports it, plus a test switch. The iOS simulator can't go offline, so
 * development and test builds have "No signal" in Settings: it reports no signal and fails every request the app
 * makes, the way a dead zone does.
 */
export interface NetworkSnapshot {
  readonly online: boolean;
  /** The last moment the phone had signal (now, while it has). */
  readonly lastOnlineAt: number;
}

const TEST_OFFLINE_KEY = 'test.offline';
const listeners = new Set<() => void>();
let reported = true;
let snapshot: NetworkSnapshot = { online: true, lastOnlineAt: Date.now() };
let started = false;

function publish() {
  const online = reported && !isTestOffline();
  if (online === snapshot.online) return;
  // Going offline keeps the moment signal was last seen; coming back moves it to now.
  snapshot = {
    online,
    lastOnlineAt: online || snapshot.online ? Date.now() : snapshot.lastOnlineAt,
  };
  for (const listener of listeners) listener();
}

function fromState(state: Network.NetworkState): boolean {
  // Unknown counts as online: the requests themselves say otherwise soon enough.
  return state.isConnected !== false && state.isInternetReachable !== false;
}

export function startNetworkWatch(): void {
  if (started) return;
  started = true;
  Network.addNetworkStateListener((state) => {
    reported = fromState(state);
    publish();
  });
  void Network.getNetworkStateAsync()
    .then((state) => {
      reported = fromState(state);
      publish();
    })
    .catch(() => undefined);
  publish();
}

export function isTestOffline(): boolean {
  return deviceStore.get<boolean>(TEST_OFFLINE_KEY) === true;
}

export function setTestOffline(offline: boolean): void {
  if (offline) deviceStore.set(TEST_OFFLINE_KEY, true);
  else deviceStore.remove(TEST_OFFLINE_KEY);
  publish();
}

export function networkSnapshot(): NetworkSnapshot {
  return snapshot;
}

export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNetwork(): NetworkSnapshot {
  return useSyncExternalStore(subscribeNetwork, networkSnapshot, networkSnapshot);
}

/**
 * `fetch` for everything the app sends (Supabase and the API). With the test switch on it fails at once, as a request
 * with no signal does.
 */
export const appFetch: typeof fetch = (input, init) => {
  if (isTestOffline()) return Promise.reject(new TypeError('Network request failed'));
  return fetch(input, init);
};
