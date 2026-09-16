import Constants from 'expo-constants';

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
  /** The web app, for the pages the phone links out to (resetting a password, desk work). */
  webUrl: (process.env.EXPO_PUBLIC_WEB_URL || 'https://app.handsfreeos.com').replace(/\/+$/, ''),
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

/** Whether this build knows where Supabase and the API are. */
export function isConfigured(): boolean {
  return Boolean(config.supabaseUrl && config.supabasePublishableKey && config.apiUrl);
}
