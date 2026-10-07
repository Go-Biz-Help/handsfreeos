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
import { STATUS_WORDS } from './migration-words';

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

/** Migrations still counting, as the Getting started card reads them. */
const MOVE_RUNNING = new Set(['connected', 'scanning', 'importing', 'verifying']);
/** Migrations finished or stopped: nothing left to open from setup. */
const MOVE_OVER = new Set(['draft', 'imported', 'completed', 'cancelling', 'cancelled']);

/**
 * A business's move from its old CRM, as setup shows it: the connection ready to move from, and the newest move not
 * finished or stopped, still counting (`running`) or waiting for a look.
 */
export function setupMoveOf({
  migrations,
  connections,
}: Awaited<ReturnType<typeof loadMigrations>>): {
  connection: { id: string; sourceLabel: string } | null;
  move: { id: string; running: boolean; words: string } | null;
} {
  const live = connections.find((x) => x.status === 'active') ?? null;
  const move = migrations.find((m) => !MOVE_OVER.has(m.status)) ?? null;
  return {
    connection: live ? { id: live.id, sourceLabel: live.sourceLabel } : null,
    move: move
      ? {
          id: move.id,
          running: MOVE_RUNNING.has(move.status),
          words: STATUS_WORDS[move.status] ?? move.status,
        }
      : null,
  };
}
