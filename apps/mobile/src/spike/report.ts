import { Platform } from 'react-native';

/** The spike's local test server (scratchpad `spike-server.mjs`). The iOS simulator reaches the Mac as localhost. */
export const SPIKE_SERVER = process.env.EXPO_PUBLIC_SPIKE_SERVER ?? 'http://localhost:8787';

declare const HermesInternal:
  { getRuntimeProperties?: () => Record<string, string | number | boolean> } | undefined;

/** The engine and platform a result came from. */
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

/** Sends a screen's results to the spike server; the screen still shows them if it isn't running. */
export async function postResults(name: string, data: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${SPIKE_SERVER}/results/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        at: new Date().toISOString(),
        environment: environment(),
        ...(data as object),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
