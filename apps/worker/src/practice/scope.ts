/**
 * Practice businesses (Admin → Try onboarding, 20261027027200): HandsFreeOS staff go through every onboarding in a
 * real business made for it, and nothing in it reaches the outside world. This is how the worker knows it's working
 * for one: the outbox, the job queue and the HTTP routes look the business up (`practiceRunFor`) and run what it asked
 * for inside `inPractice`, where `practiceNow()` says so and the services are its stand-ins (./kit.ts).
 *
 * Whether an organization is a practice one is set when it is made and never changes, so the answer is kept for good
 * once read: a real business never becomes one, and a practice one is only ever deleted.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';

export interface PracticeRun {
  readonly organizationId: string;
  /** The staff member practising in it: the only inbox its email reaches. Null once their account is gone. */
  readonly ownerEmail: string | null;
}

const store = new AsyncLocalStorage<PracticeRun>();

/** The practice business being worked for right now, or null for a real one (or none). */
export function practiceNow(): PracticeRun | null {
  return store.getStore() ?? null;
}

/** Runs `fn` as work for a practice business when there is one, and as usual otherwise. */
export function inPractice<T>(run: PracticeRun | null, fn: () => T): T {
  return run ? store.run(run, fn) : fn();
}

const known = new Map<string, PracticeRun | null>();
/** Plenty for every business there is; past it, the cache starts over rather than growing for good. */
const MOST_KEPT = 50_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/**
 * The practice run for this organization or business (the organization wins when both are given), or null for a
 * real one. Anything that isn't an id is nothing.
 */
export async function practiceRunFor(
  db: Db,
  where: { readonly organizationId?: unknown; readonly workspaceId?: unknown },
): Promise<PracticeRun | null> {
  const org = isUuid(where.organizationId) ? where.organizationId : null;
  const ws = isUuid(where.workspaceId) ? where.workspaceId : null;
  if (!org && !ws) return null;
  const key = org ? `o:${org}` : `w:${ws}`;
  if (known.has(key)) return known.get(key) ?? null;
  const [row] = await asWorker(db, {}, (tx) =>
    rows<{ organization_id: string; owner_email: string | null }>(
      tx,
      sql`select organization_id, owner_email from private.practice_run(${org}::uuid, ${ws}::uuid)`,
    ),
  );
  const run = row ? { organizationId: row.organization_id, ownerEmail: row.owner_email } : null;
  if (known.size >= MOST_KEPT) known.clear();
  known.set(key, run);
  if (run) known.set(`o:${run.organizationId}`, run);
  return run;
}

/** Tests only: forget what was read. */
export function forgetPracticeRuns(): void {
  known.clear();
}
