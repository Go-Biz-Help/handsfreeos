import { requireNativeModule } from 'expo';

/**
 * Keeps the phone's copy of each business, and photos waiting to upload, out of backups. iOS marks the folder they
 * live in (a mark on a folder covers every file ever put in it); Android leaves the whole app out of backups and
 * device transfers in its manifest, which `appBackupAllowed` reports.
 */
interface HfosBackupModule {
  /** Creates the folder if needed and keeps it out of backups; true once it is. */
  keepOutOfBackups(path: string): boolean;
  isKeptOutOfBackups(path: string): boolean;
  /** Android: whether the app allows backups at all (it shouldn't). iOS: always true, as iOS decides per folder. */
  appBackupAllowed(): boolean;
}

export default requireNativeModule<HfosBackupModule>('HfosBackup');
