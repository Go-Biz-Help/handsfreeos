import { ANDROID_DATABASE_PATH, IOS_LIBRARY_PATH } from '@op-engineering/op-sqlite';
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';

import type { CopyFiles } from './files';

/**
 * The copies' folder on this phone: op-sqlite's own default, the app's Library folder on iOS and its databases folder
 * on Android. Both go with the app when it's deleted; the Keychain entries for their keys don't (see `keys.ts`).
 */
const folder = (Platform.OS === 'ios' ? IOS_LIBRARY_PATH : ANDROID_DATABASE_PATH).replace(
  /\/+$/,
  '',
);

const uri = (name?: string) => `file://${encodeURI(name ? `${folder}/${name}` : folder)}`;

export const deviceFiles: CopyFiles = {
  folder,
  list() {
    const directory = new Directory(uri());
    if (!directory.exists) return [];
    return directory
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .map((file) => file.name);
  },
  remove(name) {
    const file = new File(uri(name));
    if (file.exists) file.delete();
  },
  header(name) {
    const file = new File(uri(name));
    if (!file.exists) return null;
    try {
      const handle = file.open();
      try {
        const bytes = handle.readBytes(16);
        return bytes.length === 16 ? bytes : null;
      } finally {
        handle.close();
      }
    } catch {
      return null;
    }
  },
};
