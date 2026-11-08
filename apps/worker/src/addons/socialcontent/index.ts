/**
 * AI Social Media Content Creator in the worker (docs/socialcontent.md): the AI's niches and the words to search for
 * them (./niches.ts), the weekly and monthly reading it queues for the business's reading computer (decision 11), and
 * the AI's notes on the standouts, the Playbook, the ideas and watching videos (./notes.ts).
 * The reading itself is the HandsFreeOS Social extension's, on that computer. The worker hands it work only while
 * it's on, and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 */
import { workQueue } from '@hfos/core/addons/socialcontent/ops/worker';
import { catalogAddon, executeCommand } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { scheduleAddonJob } from '../queue';
import type { AddonJobHandler, AddonScopeContext, AddonWorkerModule } from '../types';
import { READ_LOOK_ACTION, readLook } from './helper';
import { onNicheAdded, suggestNichesNow } from './niches';
import {
  NOTES_JOB,
  onPostsSaved,
  runNotes,
  suggestIdeasNow,
  WATCH_ACTION,
  watchPost,
  writePlaybookNow,
} from './notes';

const WEEKLY_JOB = 'socialcontent.weekly';
const MONTHLY_JOB = 'socialcontent.monthly';
const WEEK_MS = 7 * 86_400_000;
const MONTH_MS = 30 * 86_400_000;

/** Arms the weekly read and the monthly search, from now: nothing that came due while it was off runs late. */
async function armChecks(ctx: AddonScopeContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    for (const [kind, every] of [
      [WEEKLY_JOB, WEEK_MS],
      [MONTHLY_JOB, MONTH_MS],
    ] as const)
      await scheduleAddonJob(
        tx,
        { id: ctx.manifest.id, generation: ctx.generation },
        {
          kind,
          dedupeKey: `${kind}:${ctx.scope.workspaceId}`,
          runAt: new Date(Date.now() + every),
          payload: {},
          workspaceId: ctx.scope.workspaceId,
          organizationId: ctx.scope.organizationId,
        },
      );
  });
}

/** Each studied creator's posts read again; then the next week's. */
const readWeekly: AddonJobHandler = async (ctx) => {
  await executeCommand(
    ctx.db,
    workQueue,
    { workspaceId: ctx.scope.workspaceId, kind: 'posts', askedFor: 'weekly' },
    ctx.actor,
    ctx.meta,
  );
  return { rescheduleAt: new Date(ctx.now + WEEK_MS) };
};

/** Every ticked niche searched again for new creators; then the next month's. */
const findMonthly: AddonJobHandler = async (ctx) => {
  await executeCommand(
    ctx.db,
    workQueue,
    { workspaceId: ctx.scope.workspaceId, kind: 'find', askedFor: 'monthly' },
    ctx.actor,
    ctx.meta,
  );
  return { rescheduleAt: new Date(ctx.now + MONTH_MS) };
};

export const socialcontentAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('socialcontent'),
  subscribers: {
    'socialcontent.niche.added': onNicheAdded,
    'socialcontent.posts.saved': onPostsSaved,
  },
  jobs: { [WEEKLY_JOB]: readWeekly, [MONTHLY_JOB]: findMonthly, [NOTES_JOB]: runNotes },
  onEnable: armChecks,
  actions: {
    'socialcontent.niches.suggest': suggestNichesNow,
    'socialcontent.playbook.write': writePlaybookNow,
    'socialcontent.ideas.suggest': suggestIdeasNow,
    [READ_LOOK_ACTION]: readLook,
    [WATCH_ACTION]: watchPost,
  },
};
