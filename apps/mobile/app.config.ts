import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withAndroidManifest, withDangerousMod, type ConfigPlugin } from 'expo/config-plugins';

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

/** Every folder an Android app keeps things in, device-protected storage included. */
const DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];
const excludes = (indent: string) =>
  DOMAINS.map((domain) => `${indent}<exclude domain="${domain}" path="." />`).join('\n');

/**
 * Nothing of HandsFreeOS goes into Android backups or to a new phone: the encrypted copy of each business and the photos
 * waiting to upload stay on this phone, and so does SecureStore's data, whose keys never leave the phone's Keystore
 * anyway. Backups are off (app.json's `allowBackup`), which covers cloud backups; on Android 12 and later a transfer
 * from phone to phone still runs unless the data extraction rules leave everything out, so they do, and the older
 * backup rules say the same for Android 11 and earlier. iOS keeps its copies folder out of backups itself
 * (modules/hfos-backup).
 */
const withNoBackups: ConfigPlugin = (config) => {
  const withRules = withDangerousMod(config, [
    'android',
    async (mod) => {
      const folder = join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'hfos_backup_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<!-- HandsFreeOS keeps nothing in backups (app.config.ts). -->\n<full-backup-content>\n${excludes('  ')}\n</full-backup-content>\n`,
      );
      writeFileSync(
        join(folder, 'hfos_data_extraction_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<!-- HandsFreeOS keeps nothing in backups or phone-to-phone transfers (app.config.ts). -->\n<data-extraction-rules>\n  <cloud-backup>\n${excludes('    ')}\n  </cloud-backup>\n  <device-transfer>\n${excludes('    ')}\n  </device-transfer>\n</data-extraction-rules>\n`,
      );
      return mod;
    },
  ]);
  return withAndroidManifest(withRules, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:allowBackup'] = 'false';
      application.$['android:fullBackupContent'] = '@xml/hfos_backup_rules';
      application.$['android:dataExtractionRules'] = '@xml/hfos_data_extraction_rules';
    }
    return mod;
  });
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = withNoBackups(config as ExpoConfig);
  return process.env.EXPO_PUBLIC_E2E === '1' ? withPlainHttpForTests(base) : base;
};
