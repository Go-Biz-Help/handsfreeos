import Constants from 'expo-constants';

/** app.json's `extra.eas.projectId`, or null while it's empty. */
export function easProjectIdOf(extra: unknown): string | null {
  const eas = (extra as { eas?: { projectId?: unknown } } | undefined)?.eas;
  const id = typeof eas?.projectId === 'string' ? eas.projectId.trim() : '';
  return id || null;
}

/** The live worker, which every release build talks to unless it was given another address. */
export const WORKER_URL = 'https://hooks.handsfreeos.com';

/**
 * Where the worker is for this build: the address it was given, and otherwise the live one.
 *
 * A release build always has a worker, because a build made without `EXPO_PUBLIC_WORKER_URL` opened, signed in and
 * looked entirely well — and then said "The Assistant can't be reached from this app" to every question, with nothing
 * on the phone able to put it right (docs/operations.md, "What a build carries"). The address is the same for everyone
 * and is no secret, so a build that wasn't told it uses it anyway rather than shipping without an Assistant.
 *
 * A build served by Metro on someone's Mac (`__DEV__`) gets no such fallback: it is told where the worker is, in
 * `apps/mobile/.env.local`, or it goes without. Falling back there would point a local app at the live worker, which
 * acts on a real business — sends the text, books the job — and that is not something to do by accident.
 */
export function workerUrlOf(value: string | undefined, dev: boolean): string {
  const given = (value ?? '').trim();
  return (given || (dev ? '' : WORKER_URL)).replace(/\/+$/, '');
}

/**
 * Where this build of the app points, from the EXPO_PUBLIC_* values Metro writes into the bundle when it builds (each
 * must be read as `process.env.EXPO_PUBLIC_…` for that to happen). Locally they come from apps/mobile/.env.local,
 * written from `pnpm supabase:status`; the iOS simulator reaches this Mac as localhost, the Android emulator as
 * 10.0.2.2.
 */
export const config = {
  supabaseUrl: (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, ''),
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, ''),
  /** The sync service (PowerSync) that keeps the phone's copy of each business in step. */
  syncUrl: (process.env.EXPO_PUBLIC_SYNC_URL ?? '').replace(/\/+$/, ''),
  /** The web app, for the pages the phone links out to (resetting a password, desk work). */
  webUrl: (process.env.EXPO_PUBLIC_WEB_URL || 'https://app.handsfreeos.com').replace(/\/+$/, ''),
  /**
   * The worker: the Assistant behind Ask HandsFreeOS, the customer's own link for a money document, and test builds'
   * stand-in push routes (Settings → Test notifications). `workerUrlOf` says what an unset one falls back to.
   */
  workerUrl: workerUrlOf(process.env.EXPO_PUBLIC_WORKER_URL, __DEV__),
  /**
   * The app's Expo project, which Expo's push service needs before it gives the phone a push token. Its one place is
   * app.json's `expo.extra.eas.projectId` (empty until the Expo account exists; `eas init` prints the id).
   */
  easProjectId: easProjectIdOf(Constants.expoConfig?.extra),
  /**
   * Passkeys stay hidden until they can work: they need handsfreeos.com live with its association files, and the
   * native passkey module (see `src/lib/passkey.ts`).
   */
  passkeysEnabled: process.env.EXPO_PUBLIC_PASSKEYS_ENABLED === 'true',
  /** Builds for the Maestro flows: a stand-in for the Face ID prompt, and the test switches in Settings. */
  e2e: process.env.EXPO_PUBLIC_E2E === '1',
  /** The build's version, sent to the API with every request (`x-hfos-app-version`). */
  appVersion: Constants.expoConfig?.version ?? '0.0.0',
} as const;

/** Development and test builds show the test switches (no signal, changes waiting) in Settings. */
export const testToolsEnabled = __DEV__ || config.e2e;

/** Whether this build knows where Supabase, the API and the sync service are. */
export function isConfigured(): boolean {
  return Boolean(
    config.supabaseUrl && config.supabasePublishableKey && config.apiUrl && config.syncUrl,
  );
}
