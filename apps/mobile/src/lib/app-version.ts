import { config, testToolsEnabled } from './config';
import { deviceStore } from './device-store';

/**
 * The build's version, as every request to the API says it (`x-hfos-app-version`). Test builds can pretend to be a
 * build older than the API's minimum, to see the phone stop sending and keep everything until it's "updated".
 */
export const TEST_APP_VERSION_KEY = 'test.appVersion';

/** A version below any minimum the API is given. */
export const BELOW_MINIMUM_VERSION = '0.0.1';

export function appVersion(): string {
  const pretend = testToolsEnabled ? deviceStore.get<string>(TEST_APP_VERSION_KEY) : undefined;
  return typeof pretend === 'string' && pretend ? pretend : config.appVersion;
}

/** Test builds: pretend to be a build below the API's minimum, or go back to the real version. */
export function setBelowMinimumVersion(below: boolean): void {
  if (below) deviceStore.set(TEST_APP_VERSION_KEY, BELOW_MINIMUM_VERSION);
  else deviceStore.remove(TEST_APP_VERSION_KEY);
}
