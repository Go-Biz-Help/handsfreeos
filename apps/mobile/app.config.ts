import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';

/**
 * Test builds for the Maestro flows (EXPO_PUBLIC_E2E=1) are release builds that talk to Supabase and the API on the
 * computer running the emulator, over plain http (10.0.2.2). Android refuses plain http in release builds unless the
 * app allows it, so only those builds do. Everything else comes from app.json.
 */
const withPlainHttpForTests: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = 'true';
    return mod;
  });

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  return process.env.EXPO_PUBLIC_E2E === '1' ? withPlainHttpForTests(base) : base;
};
