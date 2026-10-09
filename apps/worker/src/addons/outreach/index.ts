/**
 * Social Outreach in the worker (docs/addon-architecture.md): what it does when something happens in a business, its own
 * jobs, and what it does as it arrives, turns on or off and leaves. The worker hands it work only while it's on,
 * and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * Every hook must be safe to run again: a hook that throws is retried, and the move isn't finished until it
 * succeeds. Declare in the manifest what's here: `events.consumes` for each subscriber, `jobs` for each job,
 * `resources` for what it makes at a provider (and then `releaseResource`).
 */
import { upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { catalogAddon } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import type { AddonWorkerModule } from '../types';
import { PLAYBOOK_ASSIST_ACTION, playbookAssist } from './assist';
import { downloadSaved, READ_CHATS_JOB, readChatsJob } from './chats';

export const outreachAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('outreach'),
  dataMigrations: {
    // 2: a playbook's questions have answers, and it has a pace. Reading upgrades an older one too
    // (outreach.playbook.list), so this only tidies what a reinstall brings back.
    2: async ({ tx, scope }) => {
      const kept = await rows<{ id: string; details: unknown }>(
        tx,
        sql`select id, details from addon_outreach.playbooks where workspace_id = ${scope.workspaceId}`,
      );
      for (const p of kept) {
        const details = upgradePlaybookDetails(p.details);
        if (details !== p.details)
          await tx.execute(
            sql`update addon_outreach.playbooks set details = ${JSON.stringify(details)}::jsonb
                where id = ${p.id}`,
          );
      }
    },
  },
  // The chats a download brought in, or read in Messenger, read by the AI (./chats.ts).
  subscribers: {
    'outreach.download.saved': downloadSaved,
    'outreach.chats.collected': downloadSaved,
  },
  jobs: { [READ_CHATS_JOB]: readChatsJob },
  // AI help on a playbook's parts, from the builder (./assist.ts).
  actions: { [PLAYBOOK_ASSIST_ACTION]: playbookAssist },
  // onEnable: arm recurring jobs with scheduleAddonJob, from now: nothing that came due while it was off runs late.
};
