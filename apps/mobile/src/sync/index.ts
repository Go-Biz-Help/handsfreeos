import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';

import { session } from '@/lib/auth';
import { cachedMe, keptBusinessIds } from '@/lib/businesses';
import { config } from '@/lib/config';
import { deviceStore } from '@/lib/device-store';
import { lock } from '@/lib/lock';
import { networkSnapshot, subscribeNetwork } from '@/lib/network';
import { waitingCount } from '@/lib/changes-waiting';

import { deviceFiles } from './device-files';
import { CopyKeys } from './keys';
import { copyLogger } from './logger';
import { openCopyDatabase } from './open-database';
import { PhoneCopy } from './phone-copy';

/** Readable once the phone has been unlocked after starting, and never copied to another phone or a backup. */
const KEYCHAIN: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const KEY_REGISTRY = 'copy.people';

/** The app's one copy of the business on this phone. `startApp` starts it once the sign-in and the lock are known. */
export const phoneCopy = new PhoneCopy({
  keys: new CopyKeys(
    {
      get: (name) => SecureStore.getItemAsync(name, KEYCHAIN),
      set: (name, value) => SecureStore.setItemAsync(name, value, KEYCHAIN),
      delete: (name) => SecureStore.deleteItemAsync(name, KEYCHAIN),
    },
    Crypto.getRandomBytes,
  ),
  files: deviceFiles,
  openDatabase: ({ userId, key }) =>
    openCopyDatabase({ userId, key, files: deviceFiles, logger: copyLogger }),
  keyRegistry: {
    read: () => deviceStore.get<string[]>(KEY_REGISTRY) ?? [],
    write: (ids) => deviceStore.set(KEY_REGISTRY, ids),
  },
  session,
  network: { online: () => networkSnapshot().online, subscribe: subscribeNetwork },
  lock,
  appActive: {
    subscribe: (listener) => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') listener();
      });
      return () => sub.remove();
    },
  },
  choices: deviceStore,
  keptBusinesses: (userId) => keptBusinessIds(userId, cachedMe(userId)?.businesses ?? []),
  waiting: waitingCount,
  syncUrl: config.syncUrl,
  appVersion: config.appVersion,
  logger: copyLogger,
});
