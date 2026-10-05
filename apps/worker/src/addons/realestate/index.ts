/**
 * Real Estate Agent in the worker (docs/addon-architecture.md): what it does when something happens in a business, its own
 * jobs, and what it does as it arrives, turns on or off and leaves. The worker hands it work only while it's on,
 * and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * Every hook must be safe to run again: a hook that throws is retried, and the move isn't finished until it
 * succeeds. Declare in the manifest what's here: `events.consumes` for each subscriber, `jobs` for each job,
 * `resources` for what it makes at a provider (and then `releaseResource`).
 *
 * - **The sweep** (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Health and alerts"): every fifteen minutes while
 *   it's on, the add-on's own command works each open deal out again and says where each duty is on the ladder;
 *   this raises one alert per duty that climbs as it goes, and clears the rest. Turned back on, it's armed from
 *   then: a rung reached while it was off becomes a Home card, never a late push or email. An acknowledged alert
 *   stops climbing.
 * - **Client updates** (./client-updates.ts): drafted from the deal's facts when asked or at a milestone the
 *   business keeps on, checked for fair-housing risk by the fixed list and the model, and left for the agent.
 * - **A changed wire:** reported on a deal, it raises a critical alert at once, for everyone who sees the deal, at
 *   any hour, asking to be acknowledged; the phone check finishing (done, waived or cancelled) clears it.
 */
import { ladderAlert, rungSince, SEVERITY_RANK } from '@hfos/core/addons/realestate/ladder';
import { sweep } from '@hfos/core/addons/realestate/ops/health';
import { WIRE_CHECK_KEY } from '@hfos/core/addons/realestate/own-duties';
import { catalogAddon, executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import {
  draftClosed,
  draftReady,
  draftRequested,
  draftSaved,
  milestoneReached,
} from './client-updates';
import { contractDecided, contractReadFinished, contractReadRequested } from './contract';
import {
  armEsignCheckIfOpen,
  DOCUSIGN_UPDATES,
  ESIGN,
  ESIGN_ACTIONS,
  ESIGN_CHECK,
  ESIGN_OAUTH,
  esignCheckJob,
  esignRequested,
  esignSignedReported,
  esignVoided,
} from './esign/index';
import { FEED_ACTIONS } from './feed/actions';
import { LISTING_DATA, listingDataTesters } from './feed/index';
import { compsRequested, homeLookup, listingLookup } from './feed/lookups';
import {
  armFeedCheck,
  FEED_CHECK,
  feedCheckJob,
  matchDecided,
  searchChanged,
} from './feed/searches';
import { lockboxCodeShown, lockboxEmail, lockboxOpenedAlert, readLockboxCode } from './lockboxes';
import {
  SHOWING_ACCESS,
  SHOWING_FEEDBACK,
  SHOWING_THEMES,
  showingAccessJob,
  showingDecided,
  showingFeedbackJob,
  showingFeedbackReceived,
  showingRequested,
  showingThemesJob,
  showingTimeEmail,
} from './showings';
import { armRecordsPass, dealKept, RECORDS_PASS, recordsPassJob, settingsSaved } from './records';
import { fieldNoteAdded } from './field';
import { EXPORT_JOB, exportJob, exportRequested } from './export';
import { registerRealestateTestRoutes } from './test-routes';
import { homeAdded } from './homes';
import { listingSuggested, matchBuyer, matchListing, suggestionDecided } from './matching';
import {
  descriptionRequested,
  descriptionSaved,
  factsConfirmed,
  listingAsked,
  listingPasted,
  OPEN_HOUSE_FOLLOW_UP,
  openHouseFollowedUp,
  openHouseFollowUpJob,
  openHousePlanned,
  postSaved,
  postsRequested,
  priceChanged,
  questionnaireSent,
  sellerChose,
} from './listing';
import {
  clientSpoke,
  MEMORY_JOB,
  memoryJob,
  memoryRequested,
  memoryWaitingChanged,
} from './memory';
import { tourAppointmentChanged } from './tours';
import { cmaSummaryRequested, cmaSummarySaved } from './cma';
import {
  armOfferClocks,
  OFFER_CLOCK,
  offerAnswered,
  offerClockJob,
  offerVersionAdded,
} from './offers';
import { scheduleAddonJob } from '../queue';
import type {
  AddonEventContext,
  AddonJobContext,
  AddonScopeContext,
  AddonWorkerModule,
} from '../types';

const SWEEP = 'realestate.sweep';
const EVERY = 15 * 60_000;

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;

/** The alert a wire check keeps up, by its duty. */
export const wireAlertKey = (dutyId: string) => `wire:${dutyId}`;
/** The alert a duty's ladder keeps up. */
export const dutyAlertKey = (dutyId: string) => `duty:${dutyId}`;

async function wireChangeReported(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const dutyId = typeof p['dutyId'] === 'string' ? p['dutyId'] : null;
  const dealId = ctx.event.entityId;
  if (!dutyId || !dealId) return;
  const name = typeof p['name'] === 'string' ? p['name'] : 'a deal';
  await raiseAddonAlert(ctx, {
    key: wireAlertKey(dutyId),
    severity: 'critical',
    title: `Wiring instructions changed on ${name}`.slice(0, 200),
    detail:
      'Hold every payment. Call the title or escrow company at a number you found yourself, not one in the message, before anyone sends money.',
    href: `/a/realestate/deals/${dealId}?duty=${dutyId}`,
    permission: 'realestate.use',
    customRecordId: dealId,
    assigneeUserId: typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null,
    needsAck: true,
  });
}

async function dutyFinished(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  if (typeof p['dutyId'] !== 'string') return;
  if (p['dutyKey'] === WIRE_CHECK_KEY)
    await clearAddonAlert(ctx, wireAlertKey(p['dutyId']), 'done');
  // Its ladder's card goes now, not at the next sweep.
  else await clearAddonAlert(ctx, dutyAlertKey(p['dutyId']), 'done');
}

/** Arms the sweep from now. */
async function armSweep(ctx: AddonScopeContext): Promise<void> {
  const now = Date.now();
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: SWEEP,
        dedupeKey: `${SWEEP}:${ctx.scope.workspaceId}`,
        runAt: new Date(now),
        payload: { armedAt: now },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/** `realestate.sweep`: every open deal worked out again, and each duty's alert where the ladder says. */
async function runSweep(ctx: AddonJobContext): Promise<JobResult> {
  const armedAt = Number(ctx.job.payload['armedAt'] ?? 0);
  // Round five's feed check, for a business where the add-on was on before it existed (a no-op once armed).
  await armFeedCheck(ctx);
  const { output } = await executeCommand(
    ctx.db,
    sweep,
    { workspaceId: ctx.scope.workspaceId },
    ctx.actor,
    ctx.meta,
  );
  const current = new Map(
    (
      await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ key: string; severity: keyof typeof SEVERITY_RANK; acknowledged: boolean }>(
          tx,
          sql`select key, severity, acknowledged_at is not null as acknowledged from app.addon_alerts
              where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}
                and key ~ '^(duty|contingency|blocker|chase|linked):' and cleared_at is null`,
        ),
      )
    ).map((a) => [a.key, a]),
  );
  const wanted = new Set<string>();
  for (const a of output.alerts) {
    const key = dutyAlertKey(a.dutyId);
    wanted.add(key);
    const duty = { ...a, id: a.dutyId };
    const say = ladderAlert(a.rung, duty);
    const was = current.get(key);
    // Someone said they've seen it: it stops climbing.
    if (was?.acknowledged && SEVERITY_RANK[say.severity] > SEVERITY_RANK[was.severity]) continue;
    const answering = a.accountableUserId ?? a.mainAgentUserId;
    // Critical: the deal's team and the business's alert person (its owners, unless it picked someone).
    // At risk for a business day with nobody acknowledging it: the alert people hear too (round four).
    const audience =
      say.audience === 'escalated' || a.escalated
        ? [answering, a.mainAgentUserId, ...a.coordinatorUserIds, ...output.alertPersonUserIds]
        : say.audience === 'team'
          ? [answering, a.mainAgentUserId, ...a.coordinatorUserIds]
          : [answering];
    // A rung reached before the add-on was last turned on is caught up as a Home card only.
    const quiet = rungSince(a.rung, duty) < armedAt;
    await raiseAddonAlert(ctx, {
      key,
      severity: say.severity,
      title: say.title.slice(0, 200),
      detail:
        a.escalated && say.audience !== 'escalated'
          ? `${a.dealName}. Nobody acknowledged it within a business day, so it went to the business’s alert people too.`
          : `${a.dealName}.`,
      href: `/a/realestate/deals/${a.dealId}?duty=${a.dutyId}`,
      permission: 'realestate.use',
      customRecordId: a.dealId,
      audienceUserIds: [...new Set(audience.filter((u): u is string => !!u))],
      assigneeUserId: a.accountableUserId,
      dueAt: new Date(a.dueAt),
      needsAck: say.needsAck || a.escalated,
      notify: say.notify && !quiet,
      email: say.email,
    });
  }
  // Round four: what else on a deal needs someone, each its own card until it's gone.
  for (const r of output.risks) {
    wanted.add(r.key);
    await raiseAddonAlert(ctx, {
      key: r.key,
      severity: r.severity,
      title: r.title.slice(0, 200),
      detail: r.detail,
      href: r.href,
      permission: 'realestate.use',
      customRecordId: r.dealId,
      audienceUserIds: r.audienceUserIds,
      assigneeUserId: r.assigneeUserId,
      dueAt: r.dueAt ? new Date(r.dueAt) : null,
    });
  }
  for (const key of current.keys()) if (!wanted.has(key)) await clearAddonAlert(ctx, key, 'done');
  return { rescheduleAt: new Date(ctx.now + EVERY) };
}

export const realestateAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('realestate'),
  subscribers: {
    'realestate.deal.wire_change_reported': wireChangeReported,
    'realestate.duty.completed': dutyFinished,
    'realestate.duty.waived': dutyFinished,
    'realestate.duty.cancelled': dutyFinished,
    'realestate.status_email.requested': draftRequested,
    'realestate.status_email.saved': draftSaved,
    'realestate.status_email.ready': draftReady,
    'realestate.status_email.sent': draftClosed,
    'realestate.status_email.discarded': draftClosed,
    'realestate.deal.stage_changed': milestoneReached,
    'realestate.deal.event_recorded': milestoneReached,
    'realestate.deal.closed': async (ctx) => {
      await milestoneReached(ctx);
      await dealKept(ctx);
    },
    // Round six: a deal's retention hold and whether phones keep it (./records.ts).
    'realestate.deal.opened': dealKept,
    'realestate.deal.terminated': dealKept,
    'realestate.deal.ended': dealKept,
    'realestate.deal.reopened': dealKept,
    'addon.settings_saved': settingsSaved,
    // A field note's recording, in words (./field.ts).
    'realestate.field_note.added': fieldNoteAdded,
    // The whole transaction, exported (./export.ts).
    'realestate.deal.export_requested': exportRequested,
    // Round two: a home's facts, read from its pasted listing words; round five: looked up on the listing feed.
    'realestate.home.added': async (ctx) => {
      await homeAdded(ctx);
      await homeLookup(ctx);
      await matchDecided(ctx);
    },
    // Round five: the listing feed asked, for a home, our listing, or a CMA's comps (./feed/lookups.ts).
    'realestate.home.lookup_requested': homeLookup,
    'realestate.listing.lookup_requested': listingLookup,
    'realestate.cma.comps_requested': compsRequested,
    'realestate.search.changed': searchChanged,
    'realestate.match.sent': matchDecided,
    'realestate.match.dismissed': matchDecided,
    // Buyer memory: what the client says, read for what to remember (./memory.ts).
    // And ShowingTime's emails about our listings, read into their showings (./showings.ts).
    'message.received': async (ctx) => {
      await clientSpoke(ctx);
      await showingTimeEmail(ctx);
      // Round seven: SentriLock's and Supra's "opened" emails (./lockboxes.ts).
      await lockboxEmail(ctx);
    },
    // Notices the Inbox files under Other (round seven): ShowingTime's and the lockbox makers', read the same way.
    // A person's own mail and Spam are never read.
    'email.filed': async (ctx) => {
      const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
      if (p['private'] || p['folder'] !== 'other' || p['direction'] !== 'inbound') return;
      await showingTimeEmail(ctx);
      await lockboxEmail(ctx);
    },
    'realestate.lockbox.opened': lockboxOpenedAlert,
    'addon_sealed.viewed': lockboxCodeShown,
    'call.transcribed': clientSpoke,
    'realestate.memory.requested': memoryRequested,
    'realestate.memory.suggested': memoryWaitingChanged,
    'realestate.memory.decided': memoryWaitingChanged,
    // Tours: the appointment moved or canceled on the calendar (./tours.ts).
    'appointment.rescheduled': tourAppointmentChanged,
    'appointment.cancelled': tourAppointmentChanged,
    // The CMA's summary: drafted, and every version of its words checked (./cma.ts).
    'realestate.cma.summary_requested': cmaSummaryRequested,
    'realestate.cma.summary_saved': cmaSummarySaved,
    // Offers: each version's response clock (./offers.ts).
    'realestate.offer.version_added': offerVersionAdded,
    'realestate.offer.answered': offerAnswered,
    // Round three: a listing's facts, read from its old listing's pasted words (./listing.ts).
    'realestate.listing.pasted': listingPasted,
    'realestate.listing.description_requested': descriptionRequested,
    'realestate.listing.description_saved': descriptionSaved,
    'realestate.listing.asked': listingAsked,
    'realestate.listing.posts_requested': postsRequested,
    'realestate.listing.post_saved': postSaved,
    'realestate.open_house.planned': openHousePlanned,
    'realestate.open_house.followed_up': openHouseFollowedUp,
    'realestate.offers.seller_chose': sellerChose,
    'realestate.listing.price_changed': async (ctx) => {
      await priceChanged(ctx);
      await matchListing(ctx);
    },
    // Our listings matched to our buyers (./matching.ts).
    'realestate.listing.live': matchListing,
    // And their saved search on the listing feed, asked again at once when what it asks changed (./feed/searches.ts).
    'realestate.buyer_profile.saved': async (ctx) => {
      await matchBuyer(ctx);
      await searchChanged(ctx);
    },
    'realestate.suggestion.decided': suggestionDecided,
    'realestate.listing.suggested': listingSuggested,
    // The seller's questionnaire: their agent hears, until the facts are confirmed (./listing.ts).
    'realestate.listing.questionnaire_sent': questionnaireSent,
    'realestate.listing.facts_confirmed': factsConfirmed,
    // Round four: a contract or amendment read, and its agent told while values wait (./contract.ts).
    'realestate.contract.read_requested': contractReadRequested,
    'realestate.contract.read_finished': contractReadFinished,
    'realestate.contract.confirmed': contractDecided,
    'realestate.contract.value_rejected': contractDecided,
    // Round five: documents sent for signing through DocuSign or Dotloop (./esign/index.ts).
    'realestate.esign.requested': esignRequested,
    'realestate.esign.signed_reported': esignSignedReported,
    'realestate.esign.voided': esignVoided,
    // Showings of our listings: asked for, answered, and what buyers said (./showings.ts).
    'realestate.showing.requested': showingRequested,
    'realestate.showing.decided': showingDecided,
    'realestate.showing.feedback_received': showingFeedbackReceived,
    'realestate.contingency.resolved': async (ctx) => {
      const id = payloadOf(ctx)['contingencyId'];
      if (typeof id === 'string') await clearAddonAlert(ctx, `contingency:${id}`, 'done');
    },
  },
  jobs: {
    [SWEEP]: runSweep,
    // Round five: buyers' saved searches on the listing feed (./feed/searches.ts).
    [FEED_CHECK]: feedCheckJob,
    // And open DocuSign envelopes, beside DocuSign's own updates (./esign/index.ts).
    [ESIGN_CHECK]: esignCheckJob,
    [SHOWING_ACCESS]: showingAccessJob,
    [SHOWING_FEEDBACK]: showingFeedbackJob,
    [SHOWING_THEMES]: showingThemesJob,
    [MEMORY_JOB]: memoryJob,
    [OFFER_CLOCK]: offerClockJob,
    [OPEN_HOUSE_FOLLOW_UP]: openHouseFollowUpJob,
    [RECORDS_PASS]: recordsPassJob,
    [EXPORT_JOB]: exportJob,
  },
  onEnable: async (ctx) => {
    await armSweep(ctx);
    await armOfferClocks(ctx);
    await armFeedCheck(ctx);
    await armEsignCheckIfOpen(ctx);
    await armRecordsPass(ctx);
  },
  // Round five: a pasted key for its listing feed, tried with the supplier before it's kept (./feed/index.ts).
  connectors: { [LISTING_DATA]: listingDataTesters() },
  // E-sign: the brokerage signs in to DocuSign or Dotloop; DocuSign's updates arrive at the connection's address;
  // a person opens an envelope there, or has it looked at now, through the worker (./esign/index.ts).
  oauth: { [ESIGN]: ESIGN_OAUTH },
  webhooks: { [ESIGN]: { docusign: DOCUSIGN_UPDATES } },
  actions: { ...ESIGN_ACTIONS, ...FEED_ACTIONS },
  // Round seven: a lockbox's code, read back only for core's sealed routes (./lockboxes.ts).
  sealed: { lockbox_code: readLockboxCode },
  // Playwright's: an at-risk duty aged, and the stand-in e-signature page (./test-routes.ts).
  testRoutes: registerRealestateTestRoutes,
};
