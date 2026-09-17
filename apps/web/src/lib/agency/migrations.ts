/**
 * Reading a migration for the screens (M11).
 *
 * The one thing worth knowing here: `countLabel` is what the screen shows, never `found`. A category the
 * sign-in could not reach comes back with the honest words already in it, so there is no way for a component
 * to render "0" by accident and tell a business its old system is empty when nobody was allowed to look.
 */
import type { apiServer } from '@/lib/api/server';
import { unwrap } from '@/lib/api/server';

type Api = Awaited<ReturnType<typeof apiServer>>['api'];

export type MigrationList = Awaited<ReturnType<typeof loadMigrations>>;
export type MigrationDetail = Awaited<ReturnType<typeof loadMigration>>;

export async function loadMigrations(api: Api, organizationId: string) {
  return unwrap(await api.POST('/v1/queries/migration.list', { body: { organizationId } }));
}

export async function loadMigration(api: Api, organizationId: string, migrationId: string) {
  return unwrap(
    await api.POST('/v1/queries/migration.get', { body: { organizationId, migrationId } }),
  );
}

export async function loadReviewQueue(api: Api, organizationId: string, migrationId: string) {
  return unwrap(
    await api.POST('/v1/queries/migration.review_queue', {
      body: { organizationId, migrationId, limit: 25 },
    }),
  );
}

/** Which step of the wizard a migration is on, so the page shows one thing at a time. */
export type MigrationStep = 'map' | 'choose' | 'review' | 'importing' | 'done';

export function stepOf(status: string, mapped: boolean, chosen: boolean): MigrationStep {
  if (
    status === 'importing' ||
    status === 'verifying' ||
    status === 'scanning' ||
    status === 'paused' ||
    status === 'finalizing' ||
    status === 'rolling_back'
  )
    return 'importing';
  if (status === 'imported' || status === 'transition' || status === 'completed' || status === 'rolled_back')
    return 'done';
  if (!mapped) return 'map';
  if (!chosen) return 'choose';
  return 'review';
}

/** What a person is told a migration is doing, in their words rather than the database's. */
export const STATUS_WORDS: Record<string, string> = {
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
