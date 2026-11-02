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
import type { AddonDataMigration, AddonSubscriber, AddonWorkerModule } from '../types';
import {
  armMorning,
  handOver,
  MORNING_JOB,
  morningJob,
  replySeen,
  requestAccepted,
  settingsSaved,
} from './alerts';
import {
  MESSAGE_REWRITE_ACTION,
  MESSAGE_SAMPLES_ACTION,
  messageRewrite,
  messageSamples,
} from './samples';
import { VIDEO_SCRIPT_ACTION, videoScript } from './video';
import { PROFILE_CHECK_ACTION, PROFILE_MORE_ACTION, profileCheck, profileMore } from './profile';
import { NICHE_FIT_ACTION, nicheFit, PLAYBOOK_ASSIST_ACTION, playbookAssist } from './assist';
import { CHECK_PEOPLE_JOB, checkLooked, checkPeopleJob } from './checks';
import { CHECK_PARTNERS_JOB, checkPartnersJob, partnerLooked } from './partners';
import { countriesWanted, GUESS_COUNTRIES_JOB, guessCountriesJob } from './countries';
import { downloadSaved, READ_CHATS_JOB, readChatsJob } from './chats';
import { appointmentBooked } from './demos';
import { appointmentCompleted, leadWanted } from './leads';
import {
  CHECK_GROUPS_JOB,
  checkGroupsJob,
  groupLooked,
  JOIN_ANSWER_ACTION,
  joinAnswer,
} from './groups';
import {
  CHECK_POSTS_JOB,
  checkPostsJob,
  oldGoodWanted,
  postChecked,
  postsSaved,
  recheckGoodPosts,
} from './posts';
import { DRAFT_HELPFUL_JOB, draftHelpfulJob, helpfulAsked } from './helpful';
import { LIKE_PICK_ACTION, likePick } from './likes';
import {
  HELPER_LOOK_ACTION,
  HELPER_WAY_ACTION,
  HELPER_WAYS_ACTION,
  helperLook,
  helperWay,
  helperWays,
} from './helper';
import { likeYoursFound, PICK_LIKE_YOURS_JOB, pickLikeYoursJob } from './like-yours';
import { TODAY_DRAFT_ACTION, todayDraft } from './today';
import { askCoded, askProgressed, askSettled } from './asks';
import { armPrune, LIVE_PRUNE_JOB, liveChanged, livePruneJob, warningSeen } from './live';
import { needNoted, sendWaits, WAITING_PUSH_JOB, waitingPushJob } from './waiting';
import {
  armDayReportFor,
  armDayReports,
  armReview,
  DAY_REPORT_JOB,
  dayReportJob,
  offerPublished,
  REVIEW_JOB,
  reviewJob,
} from './tracking';
import {
  armGoalCheckFor,
  armGoalChecks,
  GOAL_CHECK_JOB,
  GOAL_MIDDAY_JOB,
  goalCheckJob,
  goalMiddayJob,
} from './goal';
import { armWeekly, WEEKLY_JOB, weeklyJob } from './weekly';
import { scheduleWordsWrite, WRITE_WORDS_JOB, wordsWanted, writeWordsJob } from './words';

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
    await armReview(ctx);
  };

/** The weekly report moves with the settings, and is armed whenever the morning push is (./weekly.ts). */
const andWeekly =
  (subscriber: AddonSubscriber): AddonSubscriber =>
  async (ctx) => {
    await subscriber(ctx);
    const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
    if (p['addonId'] === undefined || p['addonId'] === ctx.manifest.id) {
      await armWeekly(ctx);
      await armReview(ctx);
    }
  };

/** Every playbook of a business in today's shape (`upgradePlaybookDetails`). */
const upgradePlaybooks: AddonDataMigration = async ({ tx, scope }) => {
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
};

/** Two subscribers to one event, one after the other. */
const both =
  (first: AddonSubscriber, second: AddonSubscriber): AddonSubscriber =>
  async (ctx) => {
    await first(ctx);
    await second(ctx);
  };

export const outreachAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('outreach'),
  dataMigrations: {
    // 2: a playbook's questions have answers, and it has a pace. 3: a niche, its problem and proof, and something
    // useful to send. 4: its follow-ups are 5 to 7, each with its quiet days (moved from the one number), and a video
    // link. 5: the video's script. 6: the kinds of partner a partner playbook looks for. 7: a playbook runs on its own
    // networks, a customers' one saved before on Facebook and LinkedIn, as it ran. 8: each network's own words, works
    // online, and the networks whose words the AI wrote, empty. 9: phrases for Facebook's post search, and the AI's
    // hashtags and LinkedIn phrases let go, then written again around the playbook's topic (decision 141). Reading
    // upgrades an older one too (outreach.playbook.list), so these only tidy what a reinstall brings back, but for 9's
    // write, asked for at once rather than at the next day's start. 10: the posts an older check called good, and
    // still open for a comment, checked again for the owner's own field (decision 143, ./posts.ts); a posts save and
    // the day's start do it for a business with the add-on on.
    2: upgradePlaybooks,
    3: upgradePlaybooks,
    4: upgradePlaybooks,
    5: upgradePlaybooks,
    6: upgradePlaybooks,
    7: upgradePlaybooks,
    8: upgradePlaybooks,
    9: async (ctx) => {
      await upgradePlaybooks(ctx);
      await scheduleWordsWrite(ctx.tx, ctx);
    },
    10: recheckGoodPosts,
  },
  // The chats a download brought in, or read in Messenger, read by the AI (./chats.ts); group posts worth a look,
  // checked by it (./posts.ts); friends and people chatted with, checked for whether they fit (./checks.ts); a reply seen, or handed over to the person, pushed to their phone, and the morning push and weekly report
  // moved with the settings (./alerts.ts, ./weekly.ts); a booking through a demo link counted (./demos.ts).
  subscribers: {
    'outreach.download.saved': andMorning(downloadSaved),
    'outreach.chats.collected': andMorning(downloadSaved),
    'outreach.posts.saved': andMorning(postsSaved),
    // A post asking for what the business offers pushes to the person who found it at once (./posts.ts, decision 49).
    'outreach.post.checked': postChecked,
    // Friends and people chatted with, read off their pages, wait for the AI's check of them (./checks.ts).
    'outreach.check.looked': andMorning(checkLooked),
    // A group's About page, rules and posts, read off Facebook, wait for the AI's check of it (./groups.ts).
    'outreach.group.looked': groupLooked,
    // A helpful post asked for is written by the AI (./helpful.ts, decision 50).
    'outreach.helpful.asked': helpfulAsked,
    'outreach.reply.seen': andWeekly(replySeen),
    // A reply handed over pushes at once (./alerts.ts); any other message that waits for the person's OK, and a
    // step the extension needs them for, push as they chose: bundled or one for each (./waiting.ts).
    'outreach.send.queued': both(handOver, sendWaits),
    'outreach.need.noted': needNoted,
    'addon.settings_saved': both(andWeekly(settingsSaved), countriesWanted),
    // People found, and the country setting, have the AI work out where they live (./countries.ts, decision 61).
    'outreach.group.saved': countriesWanted,
    'outreach.friends.saved': countriesWanted,
    // Someone accepting the person's friend request pushes to their phone, when they switched that on (./alerts.ts).
    'outreach.friend.accepted': requestAccepted,
    'appointment.booked': appointmentBooked,
    // A Facebook warning pushes to the person's phone, and what the extension tells the app keeps the feed's
    // pruning armed (./live.ts).
    'outreach.warning.seen': warningSeen,
    'outreach.live.changed': liveChanged,
    // Something the person asked of their computer needs them: their phone hears it at once, and a code it waits on
    // keeps a notification up till it's typed, the ask ends, or the code runs out (./asks.ts).
    'outreach.ask.progressed': askProgressed,
    'outreach.ask.coded': askCoded,
    'outreach.ask.ended': askSettled,
    'outreach.ask.cancelled': askSettled,
    // Starting the day, or saving one's settings, arms the day's report; a new main offer tells whoever OK'd their
    // messages against an older one (./tracking.ts). A playbook saved, a network turned on and the day started have
    // the AI write each network's own words for a customers' playbook with none (./words.ts); and, as days start on
    // their own (decision 95) with nobody pressing anything, so does the morning's first list the extension saves (a
    // safety net, decision 123).
    // And the day's looks at its first messages (./goal.ts, decision 126).
    // And the posts an older check called good go back to the check (./posts.ts, decision 143).
    'outreach.day.started': both(
      both(both(armDayReportFor, armGoalCheckFor), wordsWanted),
      oldGoodWanted,
    ),
    'outreach.automation.saved': both(both(armDayReportFor, armGoalCheckFor), wordsWanted),
    'outreach.playbook.saved': wordsWanted,
    'outreach.lists.saved': wordsWanted,
    'main_offer.published': offerPublished,
    // Someone who could partner, read off their profile, waits for the AI's partner check (./partners.ts).
    'outreach.partner.looked': partnerLooked,
    // Someone who wants a demo, or answered the playbook's questions, goes in the main pipeline (./leads.ts).
    'outreach.lead.wanted': leadWanted,
    // Once they came to the demo, their lead moves on and waits for the person's won or lost (./leads.ts).
    'appointment.completed': appointmentCompleted,
    // Instagram accounts like the business's, found by search, wait for the AI's pick (./like-yours.ts).
    'outreach.like_yours.found': likeYoursFound,
  },
  jobs: {
    [READ_CHATS_JOB]: readChatsJob,
    [CHECK_POSTS_JOB]: checkPostsJob,
    [CHECK_PEOPLE_JOB]: checkPeopleJob,
    [CHECK_PARTNERS_JOB]: checkPartnersJob,
    [CHECK_GROUPS_JOB]: checkGroupsJob,
    [DRAFT_HELPFUL_JOB]: draftHelpfulJob,
    // The morning push arms the day's reports, and the day's looks at the first messages, of whoever noted a step this
    // week (./tracking.ts, ./goal.ts).
    [MORNING_JOB]: async (ctx) => {
      const next = await morningJob(ctx);
      await armDayReports(ctx);
      await armGoalChecks(ctx);
      return next;
    },
    [WEEKLY_JOB]: weeklyJob,
    [LIVE_PRUNE_JOB]: livePruneJob,
    [WAITING_PUSH_JOB]: waitingPushJob,
    [GUESS_COUNTRIES_JOB]: guessCountriesJob,
    [DAY_REPORT_JOB]: dayReportJob,
    [REVIEW_JOB]: reviewJob,
    [WRITE_WORDS_JOB]: writeWordsJob,
    [PICK_LIKE_YOURS_JOB]: pickLikeYoursJob,
    [GOAL_CHECK_JOB]: goalCheckJob,
    [GOAL_MIDDAY_JOB]: goalMiddayJob,
  },
  // AI help on a playbook's parts, from the builder (./assist.ts), drafts for Today (./today.ts), and answers to a
  // group's questions when the extension asks to join it (./groups.ts), and which post to like (./likes.ts).
  actions: {
    [PLAYBOOK_ASSIST_ACTION]: playbookAssist,
    [NICHE_FIT_ACTION]: nicheFit,
    // The person's own profile, read by their extension, checked by the AI (./profile.ts, decision 64).
    [PROFILE_CHECK_ACTION]: profileCheck,
    // Show me more of one part of it, with the person's note (decision 84).
    [PROFILE_MORE_ACTION]: profileMore,
    [MESSAGE_SAMPLES_ACTION]: messageSamples,
    // One of them written again, with the person's note on its part (decision 87).
    [MESSAGE_REWRITE_ACTION]: messageRewrite,
    [VIDEO_SCRIPT_ACTION]: videoScript,
    [TODAY_DRAFT_ACTION]: todayDraft,
    [JOIN_ANSWER_ACTION]: joinAnswer,
    [LIKE_PICK_ACTION]: likePick,
    // The AI helper when a step didn't go, and the ways it learned (./helper.ts, decision 142).
    [HELPER_LOOK_ACTION]: helperLook,
    [HELPER_WAYS_ACTION]: helperWays,
    [HELPER_WAY_ACTION]: helperWay,
  },
  // The morning push, weekly report and review, and the feed's pruning, from now: nothing that came due while it was
  // off runs late.
  onEnable: async (ctx) => {
    await armMorning(ctx);
    await armWeekly(ctx);
    await armReview(ctx);
    await armPrune(ctx);
  },
};
