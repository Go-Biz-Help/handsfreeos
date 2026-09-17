import { ANDROID_DATABASE_PATH, IOS_LIBRARY_PATH } from '@op-engineering/op-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import HfosBackup from '../../modules/hfos-backup';

import { personOfFile, photosFolderName, type CopyFiles } from './files';

/**
 * The copies' folder on this phone. On iOS it's a folder of its own in the app's Library, kept out of iCloud and
 * computer backups (the mark on the folder covers every file SQLite makes in it); on Android it's op-sqlite's databases
 * folder, and the app's manifest keeps the whole app out of backups and device transfers. Each person's photos waiting
 * to upload are in a folder of their own: beside their copy on iOS, and in the app's files folder on Android, because
 * expo-file-system makes new files only there and in the cache folder. Never a cache folder: the system may empty
 * those, and unsent changes with them. All of it goes with the app when it's deleted; the Keychain entries for the
 * keys don't (see `keys.ts`).
 */
const base = (Platform.OS === 'ios' ? IOS_LIBRARY_PATH : ANDROID_DATABASE_PATH).replace(/\/+$/, '');
const folder = Platform.OS === 'ios' ? `${base}/HandsFreeOS` : base;

const uri = (inFolder: string, name?: string) =>
  `file://${encodeURI(name ? `${inFolder}/${name}` : inFolder)}`;

/** A photos folder, by its name, as a `file://` URI. */
const photosAt = (name: string) =>
  Platform.OS === 'ios'
    ? uri(folder, name)
    : new Directory(Paths.document, name).uri.replace(/\/+$/, '');

function filesIn(inFolder: string): string[] {
  const directory = new Directory(uri(inFolder));
  if (!directory.exists) return [];
  return directory
    .list()
    .filter((entry): entry is File => entry instanceof File)
    .map((file) => file.name);
}

export interface FolderReport {
  /** Backups leave the copies (and photos) out. */
  readonly keptOutOfBackups: boolean;
  /** Copies made before the folder existed, moved into it. */
  readonly moved: number;
}

let prepared: FolderReport | null = null;

/**
 * Makes the folder and keeps it out of backups, before any copy opens. Copies an earlier build left in Library itself
 * (M10 step 9) move in, while nothing has them open.
 */
export function prepareCopiesFolder(): FolderReport {
  if (prepared) return prepared;
  let keptOutOfBackups = false;
  try {
    keptOutOfBackups = HfosBackup.keepOutOfBackups(folder);
  } catch {
    new Directory(uri(folder)).create({ intermediates: true, idempotent: true });
  }
  let moved = 0;
  if (folder !== base)
    for (const name of filesIn(base))
      if (personOfFile(name)) {
        const target = new File(uri(folder, name));
        if (target.exists) target.delete();
        new File(uri(base, name)).moveSync(target);
        moved++;
      }
  prepared = { keptOutOfBackups, moved };
  return prepared;
}

export const deviceFiles: CopyFiles = {
  folder,
  list: () => filesIn(folder),
  remove(name) {
    const file = new File(uri(folder, name));
    if (file.exists) file.delete();
  },
  removeFolder(name) {
    const directory = new Directory(photosAt(name));
    if (directory.exists) directory.delete();
  },
  header(name) {
    const file = new File(uri(folder, name));
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

/** The folder of a person's photos waiting to upload, as a `file://` URI. */
export function photosFolderUri(userId: string): string {
  return photosAt(photosFolderName(userId));
}

/** Whether backups leave this phone's copies out: iOS reads the folder's mark, Android the app's own switch. */
export function copiesKeptOutOfBackups(): boolean {
  try {
    return HfosBackup.isKeptOutOfBackups(folder);
  } catch {
    return false;
  }
}
