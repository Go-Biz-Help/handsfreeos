/**
 * Reading a migration for the screens (M11). Server-side: the words and the step are next door, in
 * `migration-words.ts`, because the wizard is a client component.
 *
 * The one thing worth knowing: `countLabel` is what a screen shows, never `found`. A category the sign-in
 * could not reach comes back with the honest words already in it, so there is no way for a component to
 * render "0" by accident and tell a business its old system is empty when nobody was allowed to look.
 */
import type { apiServer } from '@/lib/api/server';
import { unwrap } from '@/lib/api/server';

type Api = Awaited<ReturnType<typeof apiServer>>['api'];

export type { MigrationDetail, MigrationList, MigrationReviewQueue } from './migration-words';
export { connectionWords, stepOf, STATUS_WORDS, type MigrationStep } from './migration-words';

/**
 * `workspaceId` is the business's own door (M11, 2026-09-18). Given, the answer is that business's part of
 * the migration; left out, it is the agency's view of all of it.
 */
export async function loadMigrations(api: Api, organizationId: string, workspaceId?: string) {
  return unwrap(
    await api.POST('/v1/queries/migration.list', { body: { organizationId, workspaceId } }),
  );
}

export async function loadMigration(
  api: Api,
  organizationId: string,
  migrationId: string,
  workspaceId?: string,
) {
  return unwrap(
    await api.POST('/v1/queries/migration.get', {
      body: { organizationId, migrationId, workspaceId },
    }),
  );
}

export async function loadReviewQueue(api: Api, organizationId: string, migrationId: string) {
  return unwrap(
    await api.POST('/v1/queries/migration.review_queue', {
      body: { organizationId, migrationId, limit: 25 },
    }),
  );
}
