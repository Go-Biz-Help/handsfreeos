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
import type { AddonSubscriber, AddonWorkerModule } from '../types';
import { armMorning, MORNING_JOB, morningJob, replySeen, settingsSaved } from './alerts';
import { PLAYBOOK_ASSIST_ACTION, playbookAssist } from './assist';
import { downloadSaved, READ_CHATS_JOB, readChatsJob } from './chats';
import { appointmentBooked } from './demos';
import { CHECK_POSTS_JOB, checkPostsJob, postsSaved } from './posts';
import { TODAY_DRAFT_ACTION, todayDraft } from './today';
import { armWeekly, WEEKLY_JOB, weeklyJob } from './weekly';

/**
 * What the extension sends also arms the morning push and the weekly report, for a business that had the add-on on
 * before they existed.
 */
const andMorning =
  (subscriber: AddonSubscriber): AddonSubscriber =>
  async (ctx) => {
    await subscriber(ctx);
    await armMorning(ctx);
    await armWeekly(ctx);
  };

/** The weekly report moves with the settings, and is armed whenever the morning push is (./weekly.ts). */
const andWeekly =
  (subscriber: AddonSubscriber): AddonSubscriber =>
  async (ctx) => {
    await subscriber(ctx);
    const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
    if (p['addonId'] === undefined || p['addonId'] === ctx.manifest.id) await armWeekly(ctx);
  };

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
  // The chats a download brought in, or read in Messenger, read by the AI (./chats.ts); group posts worth a look,
  // checked by it (./posts.ts); a reply seen pushed to the person's phone, and the morning push and weekly report
  // moved with the settings (./alerts.ts, ./weekly.ts); a booking through a demo link counted (./demos.ts).
  subscribers: {
    'outreach.download.saved': andMorning(downloadSaved),
    'outreach.chats.collected': andMorning(downloadSaved),
    'outreach.posts.saved': andMorning(postsSaved),
    'outreach.reply.seen': andWeekly(replySeen),
    'addon.settings_saved': andWeekly(settingsSaved),
    'appointment.booked': appointmentBooked,
  },
  jobs: {
    [READ_CHATS_JOB]: readChatsJob,
    [CHECK_POSTS_JOB]: checkPostsJob,
    [MORNING_JOB]: morningJob,
    [WEEKLY_JOB]: weeklyJob,
  },
  // AI help on a playbook's parts, from the builder (./assist.ts), and drafts for Today (./today.ts).
  actions: { [PLAYBOOK_ASSIST_ACTION]: playbookAssist, [TODAY_DRAFT_ACTION]: todayDraft },
  // The morning push and weekly report, from now: nothing that came due while it was off runs late.
  onEnable: async (ctx) => {
    await armMorning(ctx);
    await armWeekly(ctx);
  },
};
