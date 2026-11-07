/**
 * What a person is told a migration is doing, in their words rather than the database's: the badge on the Migrations
 * lists and the move's own page, and the Assistant's statusLabel. One copy, so the screens and the Assistant agree.
 */
export const MIGRATION_STATUS_WORDS: Readonly<Record<string, string>> = {
  draft: 'Not started',
  connected: 'Connected',
  scanning: 'Looking at the old system',
  scanned: 'Ready to set up',
  ready: 'Ready to bring across',
  importing: 'Bringing it across',
  paused: 'Paused',
  verifying: 'Checking it',
  imported: 'Brought across',
  transition: 'Keeping up with the old system',
  finalizing: 'Finishing',
  completed: 'Finished',
  needs_attention: 'Needs a look',
  failed: 'Stopped',
  cancelling: 'Stopping',
  cancelled: 'Stopped',
  rolling_back: 'Taking it back',
  rolled_back: 'Taken back',
};

/** A migration's status as its badge says it; one the words don't know yet, as it is. */
export const migrationStatusWords = (status: string): string =>
  MIGRATION_STATUS_WORDS[status] ?? status;
