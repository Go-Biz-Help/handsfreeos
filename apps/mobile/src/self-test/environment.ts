import { Platform } from 'react-native';

declare const HermesInternal:
  { getRuntimeProperties?: () => Record<string, string | number | boolean> } | undefined;

/** The engine and platform the self-test ran on. */
export function environment() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    hermes:
      typeof HermesInternal === 'undefined'
        ? null
        : (HermesInternal.getRuntimeProperties?.() ?? {}),
    locale: resolved.locale,
    deviceTimeZone: resolved.timeZone,
    dev: __DEV__,
  };
}
