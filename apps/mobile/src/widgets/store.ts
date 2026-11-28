import { ExtensionStorage } from '@bacons/apple-targets';
import { readWidgetsData, WIDGETS_DATA_KEY, widgetsKey, type WidgetsData } from '@hfos/core';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { deviceStore } from '@/lib/device-store';

import HfosShared from '../../modules/hfos-shared';
import { ANDROID_WIDGETS, renderAndroidWidget, type AndroidWidgetName } from './android';

/**
 * The copy the home-screen widgets read (docs/phone-widgets.md), kept by the app through modules/hfos-shared under
 * the `widgets` key, and what the Home-screen widgets screen shows about it. Saving it asks the widgets to draw again:
 * WidgetKit's reload on iPhone, each widget redrawn on Android.
 */

export function readStoredWidgets(): WidgetsData | null {
  try {
    return readWidgetsData(HfosShared.read(WIDGETS_DATA_KEY));
  } catch {
    return null;
  }
}

/**
 * How long a copy that says the same is kept before it's saved again anyway, so "Updated" on the larger widgets
 * stays near the truth without reloading the widgets on every change that alters nothing they show.
 */
export const WIDGETS_RESAVE_MS = 15 * 60_000;

let written: { key: string; at: number } | null = null;

/** Asks every widget to draw again from the copy (or from nothing, after it's forgotten). */
export function redrawWidgets(data: WidgetsData | null): void {
  try {
    if (Platform.OS === 'ios') ExtensionStorage.reloadWidget();
    if (Platform.OS === 'android')
      for (const name of Object.keys(ANDROID_WIDGETS) as AndroidWidgetName[])
        void requestWidgetUpdate({
          widgetName: name,
          renderWidget: (info) => renderAndroidWidget(name, data, info, Date.now()),
        }).catch(() => undefined);
  } catch {
    // A build without the widgets: there's nothing to draw.
  }
}

/** Saves the copy and redraws the widgets, unless it says what the copy saved lately says. */
export function storeWidgets(data: WidgetsData, now = Date.now()): boolean {
  const key = widgetsKey(data);
  if (written?.key === key && now - written.at < WIDGETS_RESAVE_MS) return true;
  try {
    const ok = HfosShared.write(WIDGETS_DATA_KEY, JSON.stringify(data));
    if (ok) {
      written = { key, at: now };
      redrawWidgets(data);
    }
    publish();
    return ok;
  } catch {
    return false;
  }
}

/** Signing out (or another person signing in) leaves nothing of theirs on the home screen. */
export function forgetWidgets(): void {
  written = null;
  try {
    HfosShared.write(WIDGETS_DATA_KEY, null);
  } catch {
    // No App Group (a build without the widgets): there was nothing to forget.
  }
  redrawWidgets(null);
  publish();
}

// ---------- Hide names on widgets (the owner's pick, 27 Nov 2026), each person's own on this phone ----------

const hideNamesKey = (userId: string) => `person.${userId}.widgetsHideNames`;

export function widgetsHideNames(userId: string): boolean {
  return deviceStore.get<boolean>(hideNamesKey(userId)) === true;
}

export function setWidgetsHideNames(userId: string, hide: boolean): void {
  if (hide) deviceStore.set(hideNamesKey(userId), true);
  else deviceStore.remove(hideNamesKey(userId));
  publish();
}

// ---------- what the Home-screen widgets screen shows ----------

interface WidgetsStatus {
  readonly refreshing: boolean;
  /** Bumped on every save and every change of the switch, so the screen and the keeper read again. */
  readonly version: number;
}

let status: WidgetsStatus = { refreshing: false, version: 0 };
const listeners = new Set<() => void>();
const refreshers = new Set<() => Promise<void>>();

function publish() {
  status = { ...status, version: status.version + 1 };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useWidgetsStatus(): WidgetsStatus {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => status,
  );
}

/** The business open now keeps the copy fresh (`KeepWidgetsFresh`); Update now asks it to build it again. */
export function onWidgetsRefresh(refresh: () => Promise<void>): () => void {
  refreshers.add(refresh);
  return () => {
    refreshers.delete(refresh);
  };
}

/** Update now: built again and saved even when nothing changed, so "Updated" says now. */
export async function refreshWidgets(): Promise<void> {
  status = { ...status, refreshing: true };
  publish();
  written = null;
  try {
    await Promise.all([...refreshers].map((refresh) => refresh()));
  } finally {
    status = { ...status, refreshing: false };
    publish();
  }
}

interface SessionLike {
  getState(): { readonly status: string; readonly person?: { readonly userId: string } };
  subscribe(listener: () => void): () => void;
}

/**
 * Forgets the widgets' copy when the person signs out, or their sign-in ends, so whoever signs in next starts with
 * none: the copy is the signed-in person's own.
 */
export function watchWidgetsOwner(session: SessionLike): void {
  let signedIn = session.getState().status === 'signedIn';
  if (session.getState().status === 'signedOut') forgetWidgets();
  session.subscribe(() => {
    const state = session.getState();
    if (state.status === 'signedOut' && signedIn) forgetWidgets();
    if (state.status !== 'starting') signedIn = state.status === 'signedIn';
  });
}
