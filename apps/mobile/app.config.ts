import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';
import {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  type ConfigPlugin,
} from 'expo/config-plugins';

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

/**
 * Every Android permission the finished app asks for has to be one it uses. Expo's template and the libraries under it
 * ask for eleven more than that, so each one is turned off here with the reason beside it, and `expo prebuild` writes
 * `tools:node="remove"` for it, which the manifest merger honours whatever a library says (step 18).
 *
 * The two storage permissions are turned off in app.json instead (`android.blockedPermissions`, step 10). Everything
 * the app really does ask for, on both platforms, is listed in apps/mobile/store/permissions.md with what asks for it.
 */
const BLOCKED_PERMISSIONS = [
  // Expo's Android template asks for this so a debug build can draw React Native's dev menu over other apps. A store
  // build has no dev menu, and "display over other apps" is a permission Play makes you justify.
  'android.permission.SYSTEM_ALERT_WINDOW',

  // expo-network asks for this for `getIpAddressAsync`, which reads the Wi-Fi address. The app only ever asks whether
  // there is signal (`src/lib/network.ts`: `getNetworkStateAsync`, `addNetworkStateListener`), which needs
  // ACCESS_NETWORK_STATE alone.
  'android.permission.ACCESS_WIFI_STATE',

  // expo-application (which comes in under expo-notifications) bundles Play's install-referrer library, for finding
  // out which ad installed the app. Nothing here asks.
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',

  // expo-notifications bundles ShortcutBadger, which puts a count on the launcher icon and needs one permission per
  // phone maker to do it. Nothing sets a badge — not the app, not the worker's push payloads — so all of them go.
  // If a count on the icon is ever wanted, this list is what to put back.
  'android.permission.READ_APP_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.android.launcher.permission.INSTALL_SHORTCUT',
  'com.android.launcher.permission.READ_SETTINGS',
  'com.android.launcher.permission.UNINSTALL_SHORTCUT',
  'com.android.launcher.permission.WRITE_SETTINGS',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
];

const withOnlyThePermissionsWeUse: ConfigPlugin = (config) =>
  AndroidConfig.Permissions.withBlockedPermissions(config, BLOCKED_PERMISSIONS);

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = withOnlyThePermissionsWeUse(withNoBackups(config as ExpoConfig));
  return process.env.EXPO_PUBLIC_E2E === '1' ? withPlainHttpForTests(base) : base;
};
