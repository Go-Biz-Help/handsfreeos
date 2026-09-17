/**
 * Where each person's copy lives: one database file per person, `hfos-<userId>.db` (with SQLite's `-wal`, `-shm` and
 * `-journal` beside it). One file each, not one shared name, because PowerSync shares its sync locks by file name: two
 * people's databases both called the same would leave the second never syncing (M10 step 5).
 */

/** The database file of a person's copy. */
export const copyFileName = (userId: string) => `hfos-${userId}.db`;

const COPY_FILE =
  /^hfos-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db(-wal|-shm|-journal)?$/;

/** Whose copy a file belongs to, or null for a file that isn't one. */
export function personOfFile(name: string): string | null {
  return COPY_FILE.exec(name)?.[1] ?? null;
}

/** "SQLite format 3" and its closing zero: the first 16 bytes of every unencrypted SQLite file. */
export const PLAIN_SQLITE_HEADER = 'SQLite format 3\u0000';

/** Whether a file's first bytes say it's plain, unencrypted SQLite. */
export function isPlainSqlite(header: Uint8Array | null): boolean {
  if (!header || header.length < PLAIN_SQLITE_HEADER.length) return false;
  return (
    String.fromCharCode(...header.slice(0, PLAIN_SQLITE_HEADER.length)) === PLAIN_SQLITE_HEADER
  );
}

/** The folder the copies live in, as the app reaches it. */
export interface CopyFiles {
  /** The folder's absolute path, where op-sqlite opens the files. */
  readonly folder: string;
  /** The names of the files in the folder. */
  list(): string[];
  /** Deletes a file if it's there. */
  remove(name: string): void;
  /** A file's first 16 bytes, or null when it doesn't exist or is shorter. */
  header(name: string): Uint8Array | null;
}

/** The people who have a copy on this phone, from the files there. */
export function peopleWithCopies(files: CopyFiles): string[] {
  return [
    ...new Set(
      files
        .list()
        .map(personOfFile)
        .filter((id): id is string => id !== null),
    ),
  ];
}

export function hasCopy(files: CopyFiles, userId: string): boolean {
  return files.list().includes(copyFileName(userId));
}

/** Deletes a person's copy: the database and SQLite's files beside it. */
export function removeCopy(files: CopyFiles, userId: string): number {
  const own = files.list().filter((name) => personOfFile(name) === userId);
  for (const name of own) files.remove(name);
  return own.length;
}
