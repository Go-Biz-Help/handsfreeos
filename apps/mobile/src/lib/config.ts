import Constants from 'expo-constants';

/** app.json's `extra.eas.projectId`, or null while it's empty. */
export function easProjectIdOf(extra: unknown): string | null {
  const eas = (extra as { eas?: { projectId?: unknown } } | undefined)?.eas;
  const id = typeof eas?.projectId === 'string' ? eas.projectId.trim() : '';
  return id || null;
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
  /** Test builds: the worker, for its stand-in push service's test routes (Settings → Test notifications). */
  workerUrl: (process.env.EXPO_PUBLIC_WORKER_URL ?? '').replace(/\/+$/, ''),
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
  /** Matomo's id for the phone app (`src/lib/analytics.ts`). Unset: nothing is counted. */
  matomoSiteId: process.env.EXPO_PUBLIC_MATOMO_SITE_ID ?? '',
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
