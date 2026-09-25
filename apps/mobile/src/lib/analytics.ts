import * as Crypto from 'expo-crypto';
import { useSegments } from 'expo-router';
import * as React from 'react';
import { AppState, Dimensions, Platform } from 'react-native';

import { config } from './config';
import { deviceStore } from './device-store';

/**
 * Matomo analytics for the phone app (gobizhelp.matomo.cloud, the site `EXPO_PUBLIC_MATOMO_SITE_ID` names): which
 * screens people open, and how often. Matomo has no SDK for React Native, so this speaks its HTTP tracking API
 * directly — one POST per screen, sent and forgotten; with no signal the view is simply not counted.
 *
 * Off in development and test builds, and in any build without a site id. What it sends is the screen's file route
 * (`/app/w/:id/customers/people/:id`), never an id, a name or anything typed; a random id for this install, kept in
 * the device store and gone with the app; and the phone's kind, system version, screen size and language. Nothing
 * says who is signed in. `store/privacy-app-store.md` and `store/privacy-play.md` declare exactly this.
 */
const MATOMO_URL = 'https://gobizhelp.matomo.cloud/matomo.php';
/** Screens are addressed under the app's id, the way Matomo's own Android SDK does it. */
const APP_URL = 'https://com.gobizhelp.handsfreeos';
const VISITOR_KEY = 'analytics.visitorId';
/** Matomo starts a new visit after 30 minutes without one; coming back later counts the screen again. */
const VISIT_GAP_MS = 30 * 60 * 1000;

/** `["app", "w", "[workspaceId]", "(tabs)", "inbox"]` → `/app/w/:id/inbox`; the root's redirect is not a screen. */
export function screenOf(segments: readonly string[]): string {
  const parts = segments
    .filter((s) => !/^\(.*\)$/.test(s) && s !== 'index')
    .map((s) => (s.startsWith('[') ? ':id' : s));
  return parts.length ? `/${parts.join('/')}` : '';
}

/** A browser-shaped description of the phone, which is what Matomo reads the device and system from. */
function userAgent(): string {
  const app = `HandsFreeOS/${config.appVersion}`;
  if (Platform.OS === 'ios') {
    const version = String(Platform.Version).replace(/\./g, '_');
    const device = Platform.isPad ? 'iPad; CPU OS' : 'iPhone; CPU iPhone OS';
    return `Mozilla/5.0 (${device} ${version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${app}`;
  }
  const { Release, Model } = Platform.constants as { Release?: string; Model?: string };
  return `Mozilla/5.0 (Linux; Android ${Release ?? Platform.Version}; ${Model ?? 'K'}) AppleWebKit/537.36 (KHTML, like Gecko) Mobile ${app}`;
}

function phone(): Record<string, string> {
  const { width, height, scale } = Dimensions.get('screen');
  return {
    ua: userAgent(),
    res: `${Math.round(width * scale)}x${Math.round(height * scale)}`,
    lang: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

function visitorId(): string {
  const saved = deviceStore.get<string>(VISITOR_KEY);
  if (typeof saved === 'string' && /^[0-9a-f]{16}$/.test(saved)) return saved;
  const id = Crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  deviceStore.set(VISITOR_KEY, id);
  return id;
}

function post(body: string): Promise<unknown> {
  return fetch(MATOMO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export interface ScreenTracker {
  /** The screen on show now; the same one twice in a row is one view. */
  screen(screen: string): void;
  /** The app is back in front: counts the screen again if Matomo has closed the visit since. */
  resume(): void;
}

export function createScreenTracker(deps: {
  siteId: string;
  visitorId: () => string;
  phone: () => Record<string, string>;
  post: (body: string) => Promise<unknown>;
  now: () => number;
}): ScreenTracker {
  let current = '';
  let previousUrl = '';
  let sentAt = 0;

  const send = () => {
    const url = `${APP_URL}${current}`;
    const fields: Record<string, string> = {
      idsite: deps.siteId,
      rec: '1',
      apiv: '1',
      send_image: '0',
      url,
      action_name: current,
      _id: deps.visitorId(),
      rand: String(Math.floor(Math.random() * 1e9)),
      ...deps.phone(),
    };
    if (previousUrl) fields.urlref = previousUrl;
    previousUrl = url;
    sentAt = deps.now();
    const body = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    // Counting a screen is never worth an error: no signal, or Matomo down, and it's simply not counted.
    deps.post(body).catch(() => undefined);
  };

  return {
    screen(screen) {
      if (!screen || screen === current) return;
      current = screen;
      send();
    },
    resume() {
      if (current && deps.now() - sentAt >= VISIT_GAP_MS) send();
    },
  };
}

const siteId = config.matomoSiteId;
const tracker: ScreenTracker | null =
  !__DEV__ && !config.e2e && /^\d+$/.test(siteId)
    ? createScreenTracker({ siteId, visitorId, phone, post, now: Date.now })
    : null;

/** Counts each screen the person opens, and the one they come back to. Called once, by the root layout. */
export function useScreenTracking(): void {
  const screen = screenOf(useSegments());

  React.useEffect(() => {
    tracker?.screen(screen);
  }, [screen]);

  React.useEffect(() => {
    if (!tracker) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') tracker.resume();
    });
    return () => subscription.remove();
  }, []);
}
