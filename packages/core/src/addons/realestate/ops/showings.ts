/**
 * Showings of our listings (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round five, step 8). Chris decided
 * (2026-10-02): both our own showing page and ShowingTime's emails.
 *
 * - **Our page.** A buyer's agent picks one of the seller's open times on the listing's public page
 *   (`realestate.public.showing_times` / `request_showing`). The seller says yes, no or another time in their portal
 *   (`realestate.portal.showing_answer`), unless the listing confirms on its own; the agent can answer for them.
 * - **After a yes**, the worker sends the access instructions to that agent alone, just before, and a feedback link
 *   after (`realestate.showing.sent`); the link's page takes their answer (`realestate.public.showing_feedback`).
 * - **ShowingTime's emails** are read by the worker into the same showings and feedback
 *   (`realestate.showing.from_email`), each to be checked by a person before it counts as right.
 * - **What buyers said** is counted here and grouped into themes by the AI (`realestate.showing.themes_saved`); the
 *   agent shares each answer with the seller when they choose.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { quoteFoundIn } from '../../../contact-ai/rules';
import { HfosError } from '../../../errors';
import { requireCustomer, requirePublic } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { FRESH_MINUTES } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { showingRequestPath, streetOf } from '../listing';
import { realestateAddon } from '../manifest';
import {
  PortalShowingAnswerInput,
  PortalShowingsInput,
  PortalShowingsOutput,
  PublicShowingFeedbackFormInput,
  PublicShowingFeedbackFormOutput,
  PublicShowingFeedbackInput,
  PublicShowingFeedbackOutput,
  PublicShowingRequestInput,
  PublicShowingRequestOutput,
  PublicShowingTimesInput,
  PublicShowingTimesOutput,
  ShowingAddInput,
  ShowingCheckInput,
  ShowingDecideInput,
  ShowingFeedbackInput,
  ShowingFromEmailInput,
  ShowingFromEmailOutput,
  ShowingListInput,
  ShowingListOutput,
  ShowingOutput,
  ShowingSentInput,
  ShowingSentOutput,
  ShowingSettingsInput,
  ShowingSettingsOutput,
  ShowingShareInput,
  ShowingThemesSaveInput,
  ShowingThemesSaveOutput,
} from '../schemas';
import {
  feedbackSummary,
  interestWords,
  openShowingTimes,
  SHOWING_HOLDS,
  SHOWING_SOURCES,
  showingSettingsOf,
  showingStateWords,
  showingWhen,
  themesWords,
  type ShowingFeedback,
  type ShowingSettings,
  type ShowingState,
  type ShowingThemes,
} from '../showings';
import { listings, showings } from '../tables';
import {
  actorUserId,
  dealClients,
  dealLine,
  historyLine,
  idUnavailable,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  requireOpen,
  timeZoneOf,
  withPhoneId,
  type Ctx,
  type Deal,
} from './common';
import { ensureListing, listingAddress, listingOf, requireListingSide } from './listing';
import { siteSlugOf } from './open-houses';
import { clientDeal, notYours } from './portal';
import { publishedListing } from './public';

type Showing = typeof showings.$inferSelect;
type Listing = typeof listings.$inferSelect;

const MINUTE = 60_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const tokenHashOf = (token: string) => createHash('sha256').update(token).digest();

/** A listing's showing settings, as the page and the agent see them: with how to get in, which stays off phones. */
export function settingsOf(
  l: Listing | null,
): Omit<ShowingSettings, 'days'> & { days: number[]; access: string | null } {
  return { ...showingSettingsOf(l), access: l?.showingAccess ?? null };
}

async function loadShowing(
  ctx: CommandContext,
  showingId: string,
): Promise<{ s: Showing; deal: Deal }> {
  const [s] = await ctx.tx
    .select()
    .from(showings)
    .where(and(eq(showings.id, showingId), eq(showings.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!s)
    throw HfosError.notFound(
      'That showing isn’t there anymore, or you’re not on its listing. Refresh to see its showings.',
    );
  const deal = await loadDeal(ctx, s.dealRecordId, { lock: true });
  return { s, deal };
}

const out = (s: Showing) => ({ showingId: s.id, dealId: s.dealRecordId, state: s.state });

/** The times a showing holds now: asked for or confirmed, and not over. */
async function heldTimes(ctx: Ctx, dealId: string, now = Date.now()) {
  return ctx.tx
    .select({ startsAt: showings.startsAt, endsAt: showings.endsAt })
    .from(showings)
    .where(
      and(
        eq(showings.dealRecordId, dealId),
        inArray(showings.state, [...SHOWING_HOLDS]),
        gt(showings.endsAt, new Date(now)),
      ),
    );
}

/** One line for a showing on the listing's timeline and history: "Ana Ruiz (Compass), Fri, Oct 9 · 2:00 PM". */
const whoWhen = (s: Pick<Showing, 'agentName' | 'brokerage' | 'startsAt'>, tz: string) =>
  `${s.agentName}${s.brokerage ? ` (${s.brokerage})` : ''}, ${showingWhen(s.startsAt, tz)}`;

async function showingEvent(
  ctx: CommandContext,
  type:
    | 'realestate.showing.requested'
    | 'realestate.showing.decided'
    | 'realestate.showing.feedback_received'
    | 'realestate.showing.feedback_shared',
  s: Showing,
  deal: Deal,
  more: { readonly before?: Record<string, unknown>; readonly payload?: object } = {},
) {
  return ctx.emit({
    type,
    entityType: 'custom_record',
    entityId: deal.recordId,
    payload: {
      name: deal.name,
      showingId: s.id,
      state: s.state,
      source: s.source,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      agentName: s.agentName,
      brokerage: s.brokerage,
      ownerUserId: deal.ownerUserId,
      ...(more.payload ?? {}),
    },
    before: more.before ?? null,
    after: { showing: s.agentName, state: s.state },
  });
}

/** Moves a showing to a decision, with its line and event. */
async function decide(
  ctx: CommandContext,
  s: Showing,
  deal: Deal,
  state: Extract<ShowingState, 'confirmed' | 'declined' | 'cancelled'>,
  by: { readonly personId?: string | null; readonly note?: string | null; readonly who: string },
) {
  const at = changeMoment(ctx.meta);
  const [now] = await ctx.tx
    .update(showings)
    .set({
      state,
      decidedAt: at,
      decidedBy: by.personId ? null : actorUserId(ctx),
      decidedByPersonId: by.personId ?? null,
      decisionNote: by.note ?? null,
      updatedAt: at,
    })
    .where(eq(showings.id, s.id))
    .returning();
  const tz = await timeZoneOf(ctx);
  await historyLine(ctx, deal, `showing_${state}`, {
    before: { showingId: s.id, state: s.state },
    after: { state, by: by.who },
    note: by.note ?? null,
  });
  const eventId = await showingEvent(ctx, 'realestate.showing.decided', now!, deal, {
    before: { state: s.state },
    payload: { note: by.note ?? null, by: by.who, was: s.state },
  });
  await dealLine(
    ctx,
    deal,
    `${state === 'confirmed' ? 'Confirmed' : state === 'declined' ? 'Turned down' : 'Cancelled'} the showing: ${whoWhen(now!, tz)}`.slice(
      0,
      300,
    ),
    {
      eventId,
      ...(by.note ? { body: by.note } : {}),
      ...(state === 'confirmed' ? {} : { tone: 'warning' as const }),
    },
  );
  return now!;
}

// ---------- the agent's ----------

export const showingSettings = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.settings',
  description:
    'How showings work on a listing: whether its page takes requests, whether the seller says yes or it’s confirmed on its own, the seller’s open days and times, a showing’s length, the access instructions, and when they and the feedback link go.',
  risk: 1,
  input: ShowingSettingsInput,
  output: ShowingSettingsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const l = await ensureListing(ctx, deal);
    const was = settingsOf(l);
    const from = input.from ?? was.from;
    const to = input.to ?? was.to;
    if (from >= to)
      throw HfosError.validation([
        { path: 'to', message: 'The last time ends after the first. Pick a later time.' },
      ]);
    const [now] = await ctx.tx
      .update(listings)
      .set({
        ...(input.open !== undefined ? { showingsOpen: input.open } : {}),
        ...(input.confirm ? { showingConfirm: input.confirm } : {}),
        ...(input.days ? { showingDays: [...new Set(input.days)].sort() } : {}),
        ...(input.from ? { showingFrom: input.from } : {}),
        ...(input.to ? { showingTo: input.to } : {}),
        ...(input.minutes ? { showingMinutes: input.minutes } : {}),
        ...(input.accessHours !== undefined ? { showingAccessHours: input.accessHours } : {}),
        ...(input.feedbackHours !== undefined ? { showingFeedbackHours: input.feedbackHours } : {}),
        ...(input.access !== undefined ? { showingAccess: input.access } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(listings.workspaceId, deal.workspaceId), eq(listings.dealRecordId, deal.recordId)),
      )
      .returning();
    await historyLine(ctx, deal, 'showing_settings', {
      before: { ...was, access: was.access ? 'set' : null },
      after: { ...settingsOf(now!), access: now!.showingAccess ? 'set' : null },
    });
    return { dealId: deal.recordId, settings: settingsOf(now!) };
  },
});

export const showingAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.add',
  description:
    'Add a showing of a listing by hand (one booked by phone, say), confirmed: the buyer’s agent, the time, and how to reach them for the access instructions and feedback link.',
  risk: 1,
  input: ShowingAddInput,
  output: ShowingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // Its confirmation goes to the buyer's agent at once: another agent, so with no signal it waits and asks again after
  // 30 minutes. The phone's id is the showing's.
  offline: { freshMinutes: FRESH_MINUTES },
  emits: ['realestate.showing.decided'],
  async handler(ctx, input) {
    // Sent again after its answer was lost: the showing it added.
    if (input.id) {
      const [had] = await ctx.tx
        .select()
        .from(showings)
        .where(and(eq(showings.id, input.id), eq(showings.workspaceId, ctx.scope.workspaceId!)));
      if (had) {
        if (had.dealRecordId !== input.dealId) throw idUnavailable();
        return out(had);
      }
    }
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireListingSide(deal);
    const l = await ensureListing(ctx, deal);
    const starts = new Date(input.startsAt);
    const ends = new Date(starts.getTime() + (input.minutes ?? settingsOf(l).minutes) * MINUTE);
    const at = changeMoment(ctx.meta);
    const [s] = await withPhoneId('showings', () =>
      ctx.tx
        .insert(showings)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          source: 'agent',
          state: 'confirmed',
          startsAt: starts,
          endsAt: ends,
          agentName: input.agentName,
          brokerage: input.brokerage ?? null,
          license: input.license ?? null,
          agentEmail: input.agentEmail ?? null,
          agentPhone: input.agentPhone ?? null,
          requestedAt: at,
          decidedAt: at,
          decidedBy: actorUserId(ctx),
          createdBy: actorUserId(ctx),
        })
        .returning(),
    );
    const tz = await timeZoneOf(ctx);
    await historyLine(ctx, deal, 'showing_added', { after: { showingId: s!.id } });
    const eventId = await showingEvent(ctx, 'realestate.showing.decided', s!, deal, {
      payload: { by: 'agent', was: null },
    });
    await dealLine(ctx, deal, `added a showing: ${whoWhen(s!, tz)}`.slice(0, 300), { eventId });
    return out(s!);
  },
});

export const showingDecide = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.decide',
  description:
    'Answer a showing request for the seller (confirm or turn it down), or cancel a showing, with a note. The buyer’s agent hears.',
  risk: 2,
  input: ShowingDecideInput,
  output: ShowingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_answer_showing',
    description: 'Confirm, turn down or cancel a showing of a listing, for the seller.',
  },
  // The buyer's agent hears: answering waits on the phone and asks again after 30 minutes (board 89).
  offline: { freshMinutes: FRESH_MINUTES },
  emits: ['realestate.showing.decided'],
  async handler(ctx, input) {
    const { s, deal } = await loadShowing(ctx, input.showingId);
    requireNotArchived(deal);
    const target =
      input.decision === 'confirm'
        ? 'confirmed'
        : input.decision === 'decline'
          ? 'declined'
          : 'cancelled';
    if (s.state === target) return out(s);
    const allowed =
      input.decision === 'cancel'
        ? s.state === 'requested' || s.state === 'confirmed'
        : s.state === 'requested';
    if (!allowed)
      throw HfosError.rule(
        'realestate_showing_settled',
        409,
        `That showing is ${SHOWING_STATE_WORDS(s.state)}, so it can’t be ${
          input.decision === 'confirm'
            ? 'confirmed'
            : input.decision === 'decline'
              ? 'turned down'
              : 'cancelled'
        } now.`,
      );
    if (input.decision === 'confirm' && s.endsAt.getTime() <= Date.now())
      throw HfosError.rule(
        'realestate_showing_past',
        409,
        'That time has passed. Add the showing again for a new time.',
      );
    return out(await decide(ctx, s, deal, target, { note: input.note ?? null, who: 'agent' }));
  },
});

const SHOWING_STATE_WORDS = (state: ShowingState) =>
  ({
    requested: 'waiting on the seller',
    confirmed: 'confirmed',
    declined: 'turned down',
    cancelled: 'cancelled',
    done: 'over',
  })[state];

export const showingCheck = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.check',
  description:
    'Say a showing read from a ShowingTime email is right, correcting its time or agent if it was read wrong.',
  risk: 1,
  input: ShowingCheckInput,
  output: ShowingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { s, deal } = await loadShowing(ctx, input.showingId);
    requireNotArchived(deal);
    const length = s.endsAt.getTime() - s.startsAt.getTime();
    const starts = input.startsAt ? new Date(input.startsAt) : s.startsAt;
    const [now] = await ctx.tx
      .update(showings)
      .set({
        checked: true,
        startsAt: starts,
        endsAt: new Date(starts.getTime() + length),
        ...(input.agentName ? { agentName: input.agentName } : {}),
        updatedAt: new Date(),
      })
      .where(eq(showings.id, s.id))
      .returning();
    await historyLine(ctx, deal, 'showing_checked', {
      before: { showingId: s.id, startsAt: s.startsAt.toISOString(), agentName: s.agentName },
      after: { startsAt: now!.startsAt.toISOString(), agentName: now!.agentName },
    });
    return out(now!);
  },
});

/** Keeps feedback on a showing, from whoever gave it; the showing is over once there's feedback. */
async function keepFeedback(
  ctx: CommandContext,
  s: Showing,
  deal: Deal,
  feedback: ShowingFeedback,
  source: 'page' | 'showingtime' | 'agent',
) {
  const at = changeMoment(ctx.meta);
  const [now] = await ctx.tx
    .update(showings)
    .set({
      feedback: feedback as unknown as Record<string, unknown>,
      feedbackAt: at,
      feedbackSource: source,
      ...(s.state === 'confirmed' ? { state: 'done' as const } : {}),
      updatedAt: at,
    })
    .where(eq(showings.id, s.id))
    .returning();
  const tz = await timeZoneOf(ctx);
  await historyLine(ctx, deal, 'showing_feedback', {
    after: { showingId: s.id, source, interest: feedback.interest },
  });
  const eventId = await showingEvent(ctx, 'realestate.showing.feedback_received', now!, deal, {
    payload: { interest: feedback.interest, feedbackSource: source },
  });
  await dealLine(
    ctx,
    deal,
    `Feedback from ${whoWhen(now!, tz)}${feedback.interest ? `: ${feedback.interest} of 5` : ''}`.slice(
      0,
      300,
    ),
    {
      eventId,
      body:
        [
          feedback.liked && `Liked: ${feedback.liked}`,
          feedback.pause && `Gave pause: ${feedback.pause}`,
        ]
          .filter(Boolean)
          .join('\n') || null,
    },
  );
  return now!;
}

export const showingFeedback = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.feedback',
  description:
    'Record what a buyer’s agent said about a showing (their buyers’ interest, what they liked, what gave them pause, how the price felt), when they said it by phone or text.',
  risk: 1,
  input: ShowingFeedbackInput,
  output: ShowingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // What the buyer's agent said on the phone, noted with no signal. Their own answer, given after it, stays.
  offline: 'anytime',
  emits: ['realestate.showing.feedback_received'],
  async handler(ctx, input) {
    const { s, deal } = await loadShowing(ctx, input.showingId);
    requireNotArchived(deal);
    if (s.state === 'declined' || s.state === 'cancelled')
      throw HfosError.rule(
        'realestate_showing_settled',
        409,
        `That showing was ${SHOWING_STATE_WORDS(s.state)}, so there’s no feedback to keep.`,
      );
    if (
      s.feedbackSource &&
      s.feedbackSource !== 'agent' &&
      s.feedbackAt &&
      s.feedbackAt.getTime() > changeMoment(ctx.meta).getTime()
    )
      throw HfosError.rule(
        'realestate_showing_feedback_theirs',
        409,
        `${s.agentName} ${s.feedbackSource === 'page' ? 'answered the feedback link' : 'sent feedback through ShowingTime'} ${showingWhen(s.feedbackAt, await timeZoneOf(ctx))}, after you noted it here, so theirs stays. Add what you heard as a note on the showing.`,
      );
    const was = (s.feedback ?? {}) as Partial<ShowingFeedback>;
    const feedback: ShowingFeedback = {
      interest: input.interest !== undefined ? input.interest : (was.interest ?? null),
      liked: input.liked !== undefined ? input.liked : (was.liked ?? null),
      pause: input.pause !== undefined ? input.pause : (was.pause ?? null),
      price: input.price !== undefined ? input.price : (was.price ?? null),
    };
    if (!feedback.interest && !feedback.liked && !feedback.pause && !feedback.price)
      throw HfosError.validation([
        { path: 'interest', message: 'Add their interest, or what they said about it.' },
      ]);
    return out(await keepFeedback(ctx, s, deal, feedback, 'agent'));
  },
});

export const showingShare = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.share_feedback',
  description: 'Share a showing’s feedback with the seller in their portal, as it was given.',
  risk: 2,
  input: ShowingShareInput,
  output: ShowingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.showing.feedback_shared'],
  async handler(ctx, input) {
    const { s, deal } = await loadShowing(ctx, input.showingId);
    requireOpen(deal);
    if (!s.feedback)
      throw HfosError.rule(
        'realestate_showing_no_feedback',
        409,
        'There’s no feedback on that showing yet. Share it once the buyer’s agent answers.',
      );
    if (s.feedbackSharedAt) return out(s);
    const [now] = await ctx.tx
      .update(showings)
      .set({ feedbackSharedAt: changeMoment(ctx.meta), updatedAt: new Date() })
      .where(eq(showings.id, s.id))
      .returning();
    await historyLine(ctx, deal, 'showing_feedback_shared', { after: { showingId: s.id } });
    await showingEvent(ctx, 'realestate.showing.feedback_shared', now!, deal);
    return out(now!);
  },
});

export const showingList = defineAddonQuery(realestateAddon, {
  name: 'realestate.showing.list',
  description:
    'A listing’s showings, newest first: who, when, where each stands and where it came from (its page, ShowingTime’s emails, or added by hand), the feedback, what buyers said in all, and how showings work on it.',
  input: ShowingListInput,
  output: ShowingListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_showings',
    description: 'A listing’s showings and what buyers said after them.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireListingSide(deal);
    const [l, list, tz, clients, address] = await Promise.all([
      listingOf(ctx, deal.recordId),
      ctx.tx
        .select()
        .from(showings)
        .where(eq(showings.dealRecordId, deal.recordId))
        .orderBy(desc(showings.startsAt), desc(showings.id)),
      timeZoneOf(ctx),
      dealClients(ctx, deal.recordId),
      listingAddress(ctx, deal),
    ]);
    const site = l?.slug && l.pageState === 'published' ? await siteSlugOf(ctx) : null;
    const seller = clients[0]?.firstName ?? null;
    const now = Date.now();
    const summary = feedbackSummary(
      list.map((s) => ({
        state: s.state,
        feedback: (s.feedback as ShowingFeedback | null) ?? null,
      })),
    );
    const themes = l?.showingThemes as ShowingThemes | null | undefined;
    return {
      dealId: deal.recordId,
      street: address ? streetOf(address) : null,
      requestPath: site && l?.slug ? showingRequestPath(site, l.slug) : null,
      sellerFirstName: seller,
      settings: settingsOf(l),
      showings: list.map((s) => {
        const ahead = s.endsAt.getTime() > now;
        return {
          id: s.id,
          source: s.source,
          sourceLabel: SHOWING_SOURCES[s.source],
          state: s.state,
          stateWords: showingStateWords(s.state, seller),
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          when: showingWhen(s.startsAt, tz),
          agentName: s.agentName,
          brokerage: s.brokerage,
          license: s.license,
          agentEmail: s.agentEmail,
          agentPhone: s.agentPhone,
          checked: s.checked,
          requestedAt: s.requestedAt.toISOString(),
          decidedAt: iso(s.decidedAt),
          decisionNote: s.decisionNote,
          accessSentAt: iso(s.accessSentAt),
          feedbackAskedAt: iso(s.feedbackAskedAt),
          feedback: (s.feedback as ShowingFeedback | null) ?? null,
          feedbackAt: iso(s.feedbackAt),
          feedbackSource: s.feedbackSource,
          feedbackSharedAt: iso(s.feedbackSharedAt),
          can: {
            confirm: s.state === 'requested' && ahead,
            decline: s.state === 'requested',
            cancel: (s.state === 'requested' || s.state === 'confirmed') && ahead,
            check: !s.checked,
            feedback: s.state === 'confirmed' || s.state === 'done',
            share: !!s.feedback && !s.feedbackSharedAt,
          },
        };
      }),
      summary: { ...summary, interestWords: interestWords(summary.averageInterest) },
      themes:
        themes && l?.showingThemesAt
          ? {
              liked: themes.liked.map((t) => ({ ...t, quotes: [...t.quotes] })),
              disliked: themes.disliked.map((t) => ({ ...t, quotes: [...t.quotes] })),
              likedWords: themesWords(themes.liked),
              dislikedWords: themesWords(themes.disliked),
              at: l.showingThemesAt.toISOString(),
            }
          : null,
    };
  },
});

// ---------- the listing's page (anyone with the link) ----------

/** The listing a showing page is for, and why it isn't taking requests when it isn't. */
async function showingPage(ctx: Ctx, slug: string) {
  const { l, deal, status, address } = await publishedListing(ctx, slug);
  const settings = settingsOf(l);
  const closedWords =
    status !== 'for_sale'
      ? `${streetOf(address)} is ${status === 'sold' ? 'sold' : 'under contract'}, so it isn’t being shown.`
      : !settings.open || !settings.days.length
        ? `${streetOf(address)} isn’t taking showing requests here right now. Contact the listing agent.`
        : null;
  return { l, deal, address, settings, closedWords };
}

export const publicShowingTimes = defineAddonQuery(realestateAddon, {
  name: 'realestate.public.showing_times',
  description:
    'The seller’s open times for a showing over the next week, on the listing’s page, for a buyer’s agent to pick one.',
  input: PublicShowingTimesInput,
  output: PublicShowingTimesOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  async handler(ctx, input) {
    requirePublic(ctx);
    const { deal, address, settings, closedWords } = await showingPage(ctx, input.slug);
    const tz = await timeZoneOf(ctx);
    return {
      street: streetOf(address),
      open: !closedWords,
      closedWords,
      times: closedWords ? [] : openShowingTimes(settings, tz, await heldTimes(ctx, deal.recordId)),
      minutes: settings.minutes,
      timeZone: tz,
      confirm: settings.confirm,
    };
  },
});

export const publicShowingRequest = defineAddonCommand(realestateAddon, {
  name: 'realestate.public.request_showing',
  description:
    'A buyer’s agent asks for one of the seller’s open times on the listing’s page. The seller says yes in their portal, unless the listing confirms on its own; their details go only to the listing’s agent and the seller.',
  risk: 2,
  input: PublicShowingRequestInput,
  output: PublicShowingRequestOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  emits: ['realestate.showing.requested', 'realestate.showing.decided'],
  async handler(ctx, input) {
    requirePublic(ctx);
    const { deal, address, settings, closedWords } = await showingPage(ctx, input.slug);
    if (closedWords) throw HfosError.rule('realestate_showings_closed', 409, closedWords);
    const tz = await timeZoneOf(ctx);
    const starts = new Date(input.startsAt);
    const open = openShowingTimes(settings, tz, await heldTimes(ctx, deal.recordId));
    if (!open.includes(starts.toISOString()))
      throw HfosError.rule(
        'realestate_showing_time_gone',
        409,
        `${showingWhen(starts, tz)} isn’t open any more. Pick another time.`,
      );
    const email = input.email.toLowerCase();
    const [already] = await ctx.tx
      .select({ startsAt: showings.startsAt })
      .from(showings)
      .where(
        and(
          eq(showings.dealRecordId, deal.recordId),
          eq(showings.agentEmail, email),
          eq(showings.state, 'requested'),
          gt(showings.startsAt, new Date()),
        ),
      )
      .limit(1);
    if (already)
      throw HfosError.rule(
        'realestate_showing_asked',
        409,
        `You’ve already asked to show ${streetOf(address)} ${showingWhen(already.startsAt, tz)}. You’ll hear once the seller answers.`,
      );
    const auto = settings.confirm === 'auto';
    const at = changeMoment(ctx.meta);
    const [s] = await ctx.tx
      .insert(showings)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        source: 'page',
        state: 'requested',
        startsAt: starts,
        endsAt: new Date(starts.getTime() + settings.minutes * MINUTE),
        agentName: input.agentName,
        brokerage: input.brokerage,
        license: input.license,
        agentEmail: email,
        agentPhone: input.phone ?? null,
        requestedAt: at,
      })
      .returning();
    await historyLine(ctx, deal, 'showing_requested', { after: { showingId: s!.id } });
    const eventId = await showingEvent(ctx, 'realestate.showing.requested', s!, deal, {
      payload: { auto, street: streetOf(address) },
    });
    await dealLine(ctx, deal, `${whoWhen(s!, tz)}: asked to show it on its page`.slice(0, 300), {
      eventId,
    });
    if (auto) {
      const confirmed = await decide(ctx, s!, deal, 'confirmed', { who: 'listing' });
      return { state: 'confirmed' as const, startsAt: confirmed.startsAt.toISOString() };
    }
    return { state: 'requested' as const, startsAt: s!.startsAt.toISOString() };
  },
});

/** The showing a feedback link is for. */
async function feedbackShowing(ctx: Ctx, slug: string, token: string) {
  const gone = () =>
    HfosError.notFound(
      'That feedback link doesn’t work any more. Reply to the email instead, and the listing agent will get it.',
    );
  const { deal, address } = await publishedListing(ctx, slug).catch(() => {
    throw gone();
  });
  const [s] = await ctx.tx
    .select()
    .from(showings)
    .where(
      and(
        eq(showings.workspaceId, ctx.scope.workspaceId!),
        eq(showings.feedbackTokenHash, tokenHashOf(token)),
      ),
    );
  if (!s || s.dealRecordId !== deal.recordId) throw gone();
  return { s, deal, address };
}

export const publicShowingFeedbackForm = defineAddonQuery(realestateAddon, {
  name: 'realestate.public.showing_feedback_form',
  description:
    'The feedback page a buyer’s agent opens after a showing: the home, when, and whether they’ve answered.',
  input: PublicShowingFeedbackFormInput,
  output: PublicShowingFeedbackFormOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  async handler(ctx, input) {
    requirePublic(ctx);
    const { s, address } = await feedbackShowing(ctx, input.slug, input.token);
    return {
      street: streetOf(address),
      startsAt: s.startsAt.toISOString(),
      agentName: s.agentName,
      answered: !!s.feedback,
    };
  },
});

export const publicShowingFeedback = defineAddonCommand(realestateAddon, {
  name: 'realestate.public.showing_feedback',
  description:
    'A buyer’s agent says how a showing went, from the link they were sent: their buyers’ interest, what they liked, what gave them pause, how the price felt. It goes to the listing agent.',
  risk: 1,
  input: PublicShowingFeedbackInput,
  output: PublicShowingFeedbackOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  emits: ['realestate.showing.feedback_received'],
  async handler(ctx, input) {
    requirePublic(ctx);
    const found = await feedbackShowing(ctx, input.slug, input.token);
    const { s, deal } = await (async () => {
      const [locked] = await ctx.tx
        .select()
        .from(showings)
        .where(eq(showings.id, found.s.id))
        .for('update');
      return { s: locked!, deal: found.deal };
    })();
    if (s.feedback)
      throw HfosError.rule(
        'realestate_showing_answered',
        409,
        'You’ve already sent feedback on this showing. Thank you. Reply to the email to add anything.',
      );
    await keepFeedback(
      ctx,
      s,
      deal,
      {
        interest: input.interest,
        liked: input.liked || null,
        pause: input.pause || null,
        price: input.price ?? null,
      },
      'page',
    );
    return { sent: true as const };
  },
});

// ---------- the seller's (in their portal) ----------

export const portalShowings = defineAddonQuery(realestateAddon, {
  name: 'realestate.portal.showings',
  description:
    'The seller’s showings in their portal: requests waiting for their answer, those coming up, and the feedback their agent shared.',
  input: PortalShowingsInput,
  output: PortalShowingsOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx, input) {
    requireCustomer(ctx);
    const list = await ctx.tx
      .select({
        id: showings.id,
        source: showings.source,
        state: showings.state,
        startsAt: showings.startsAt,
        endsAt: showings.endsAt,
        agentName: showings.agentName,
        brokerage: showings.brokerage,
        requestedAt: showings.requestedAt,
        feedback: showings.feedback,
        feedbackSharedAt: showings.feedbackSharedAt,
      })
      .from(showings)
      .where(eq(showings.dealRecordId, input.dealId))
      .orderBy(asc(showings.startsAt));
    const [l] = await ctx.tx
      .select({ confirm: listings.showingConfirm })
      .from(listings)
      .where(eq(listings.dealRecordId, input.dealId));
    const now = Date.now();
    return {
      dealId: input.dealId,
      waiting: list
        .filter((s) => s.state === 'requested' && s.endsAt.getTime() > now)
        .map((s) => ({
          id: s.id,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          agentName: s.agentName,
          brokerage: s.brokerage,
          source: s.source,
          requestedAt: s.requestedAt.toISOString(),
        })),
      upcoming: list
        .filter((s) => s.state === 'confirmed' && s.endsAt.getTime() > now)
        .map((s) => ({
          id: s.id,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          agentName: s.agentName,
          brokerage: s.brokerage,
          source: s.source,
        })),
      feedback: list
        .filter((s) => s.feedback && s.feedbackSharedAt)
        .reverse()
        .map((s) => ({
          id: s.id,
          startsAt: s.startsAt.toISOString(),
          feedback: s.feedback as unknown as ShowingFeedback,
          sharedAt: s.feedbackSharedAt!.toISOString(),
        })),
      confirm: l?.confirm ?? 'seller',
    };
  },
});

export const portalShowingAnswer = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.showing_answer',
  description:
    'The seller answers a showing request in their portal: yes, no, or another time (with their words). The buyer’s agent and the listing agent hear.',
  risk: 1,
  input: PortalShowingAnswerInput,
  output: ShowingOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.showing.decided'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [found] = await ctx.tx
      .select({ dealRecordId: showings.dealRecordId })
      .from(showings)
      .where(
        and(eq(showings.id, input.showingId), eq(showings.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!found) throw notYours();
    const deal = await clientDeal(ctx, found.dealRecordId);
    if (deal.side !== 'listing') throw notYours();
    requireOpen(deal);
    const { s } = await loadShowing(ctx, input.showingId);
    if (s.state !== 'requested')
      throw HfosError.rule(
        'realestate_showing_settled',
        409,
        `That showing is ${SHOWING_STATE_WORDS(s.state)} already. Your agent will tell you if anything changes.`,
      );
    if (input.answer === 'yes' && s.endsAt.getTime() <= Date.now())
      throw HfosError.rule(
        'realestate_showing_past',
        409,
        'That time has passed. Nothing more to do.',
      );
    const name =
      (await dealClients(ctx, deal.recordId)).find((c) => c.id === me.personId)?.firstName ??
      'The seller';
    const note =
      input.answer === 'another' ? (input.words ?? 'Another time, please.') : (input.words ?? null);
    const now = await decide(ctx, s, deal, input.answer === 'yes' ? 'confirmed' : 'declined', {
      personId: me.personId,
      note,
      who: name,
    });
    return out(now);
  },
});

// ---------- the worker's ----------

export const showingSent = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.sent',
  description:
    'Worker: a confirmed showing’s access instructions went to its agent, or its feedback link did (its token kept hashed); a showing whose feedback was asked for is over.',
  risk: 0,
  input: ShowingSentInput,
  output: ShowingSentOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { s } = await loadShowing(ctx, input.showingId);
    const at = new Date();
    if (input.what === 'access') {
      if (s.accessSentAt) return { showingId: s.id, changed: false };
      await ctx.tx.update(showings).set({ accessSentAt: at }).where(eq(showings.id, s.id));
      return { showingId: s.id, changed: true };
    }
    if (s.feedbackAskedAt) return { showingId: s.id, changed: false };
    await ctx.tx
      .update(showings)
      .set({
        feedbackAskedAt: at,
        ...(input.tokenHash ? { feedbackTokenHash: Buffer.from(input.tokenHash, 'hex') } : {}),
        ...(s.state === 'confirmed' ? { state: 'done' as const } : {}),
      })
      .where(eq(showings.id, s.id));
    return { showingId: s.id, changed: true };
  },
});

/** A ShowingTime email's showing, by its reference or by the same time on the same listing. */
async function emailShowing(
  ctx: CommandContext,
  dealId: string,
  externalId: string | null,
  startsAt: Date | null,
) {
  if (externalId) {
    const [s] = await ctx.tx
      .select()
      .from(showings)
      .where(
        and(eq(showings.workspaceId, ctx.scope.workspaceId!), eq(showings.externalId, externalId)),
      )
      .for('update');
    if (s) return s;
  }
  if (!startsAt) return null;
  const [s] = await ctx.tx
    .select()
    .from(showings)
    .where(
      and(
        eq(showings.dealRecordId, dealId),
        eq(showings.source, 'showingtime'),
        eq(showings.startsAt, startsAt),
      ),
    )
    .for('update');
  return s ?? null;
}

export const showingFromEmail = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.from_email',
  description:
    'Worker: what a ShowingTime email said about a showing of a listing (asked for, confirmed, cancelled, or its feedback), kept to be checked by a person.',
  risk: 0,
  input: ShowingFromEmailInput,
  output: ShowingFromEmailOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [
    'realestate.showing.requested',
    'realestate.showing.decided',
    'realestate.showing.feedback_received',
  ],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    if (deal.archivedAt || deal.side !== 'listing')
      return { showingId: null, state: 'skipped' as const };
    const starts = input.startsAt ? new Date(input.startsAt) : null;
    const found = await emailShowing(ctx, deal.recordId, input.externalId ?? null, starts);
    const tz = await timeZoneOf(ctx);
    if (input.kind === 'feedback') {
      if (!found || !input.feedback)
        return { showingId: found?.id ?? null, state: 'skipped' as const };
      if (found.feedback) return { showingId: found.id, state: found.state };
      const now = await keepFeedback(ctx, found, deal, input.feedback, 'showingtime');
      return { showingId: now.id, state: now.state };
    }
    if (!found) {
      if (!starts || input.kind === 'cancelled')
        return { showingId: null, state: 'skipped' as const };
      const l = await listingOf(ctx, deal.recordId);
      const ends = input.endsAt
        ? new Date(input.endsAt)
        : new Date(starts.getTime() + settingsOf(l).minutes * MINUTE);
      const [s] = await ctx.tx
        .insert(showings)
        .values({
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          source: 'showingtime',
          state: input.kind === 'confirmed' ? 'confirmed' : 'requested',
          startsAt: starts,
          endsAt: ends > starts ? ends : new Date(starts.getTime() + 30 * MINUTE),
          agentName: input.agentName ?? 'A buyer’s agent',
          brokerage: input.brokerage ?? null,
          agentEmail: input.agentEmail?.toLowerCase() || null,
          agentPhone: input.agentPhone || null,
          checked: false,
          externalId: input.externalId ?? null,
          messageId: input.messageId ?? null,
          ...(input.kind === 'confirmed' ? { decidedAt: new Date() } : {}),
        })
        .returning();
      await historyLine(ctx, deal, 'showing_from_email', {
        after: { showingId: s!.id, kind: input.kind },
      });
      const eventId = await showingEvent(
        ctx,
        input.kind === 'confirmed' ? 'realestate.showing.decided' : 'realestate.showing.requested',
        s!,
        deal,
        { payload: { fromEmail: true, by: 'showingtime', was: null } },
      );
      await dealLine(
        ctx,
        deal,
        `ShowingTime: ${input.kind === 'confirmed' ? 'confirmed' : 'asked for'} ${whoWhen(s!, tz)}`.slice(
          0,
          300,
        ),
        { eventId, body: 'Read from ShowingTime’s email. Check it on Showings.' },
      );
      return { showingId: s!.id, state: s!.state };
    }
    const next: ShowingState | null =
      input.kind === 'confirmed' && found.state === 'requested'
        ? 'confirmed'
        : input.kind === 'cancelled' && SHOWING_HOLDS.includes(found.state)
          ? 'cancelled'
          : null;
    if (!next) return { showingId: found.id, state: found.state };
    const now = await decide(ctx, found, deal, next as 'confirmed' | 'cancelled', {
      who: 'ShowingTime',
      note: next === 'cancelled' ? 'Cancelled through ShowingTime.' : null,
    });
    await ctx.tx.update(showings).set({ checked: false }).where(eq(showings.id, now.id));
    return { showingId: now.id, state: now.state };
  },
});

export const showingThemesSaved = defineAddonCommand(realestateAddon, {
  name: 'realestate.showing.themes_saved',
  description:
    'Worker: what buyers said after a listing’s showings, grouped by the AI into what they liked and what they didn’t, each with how many said it and their words.',
  risk: 0,
  input: ShowingThemesSaveInput,
  output: ShowingThemesSaveOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    await ensureListing(ctx, deal);
    // Their words only: a quote that isn't in what they wrote is dropped (and a theme with none), and no theme is
    // said by more answers than there are.
    const said = (
      await ctx.tx
        .select({ feedback: showings.feedback })
        .from(showings)
        .where(eq(showings.dealRecordId, deal.recordId))
    )
      .map((r) => r.feedback as ShowingFeedback | null)
      .filter((f): f is ShowingFeedback => !!f);
    const liked = said.map((f) => f.liked ?? '').join('\n');
    const paused = said.map((f) => f.pause ?? '').join('\n');
    const keep = (themes: ShowingThemes['liked'], text: string) =>
      themes
        .map((t) => ({
          theme: t.theme,
          count: Math.min(t.count, said.length),
          quotes: t.quotes.filter((q) => quoteFoundIn(q, text)),
        }))
        .filter((t) => t.quotes.length > 0);
    const themes = {
      liked: keep(input.themes.liked, liked),
      disliked: keep(input.themes.disliked, paused),
    };
    await ctx.tx
      .update(listings)
      .set({
        showingThemes: themes as unknown as Record<string, unknown>,
        showingThemesAt: new Date(),
      })
      .where(
        and(eq(listings.workspaceId, deal.workspaceId), eq(listings.dealRecordId, deal.recordId)),
      );
    return { dealId: deal.recordId };
  },
});

export const showingCommands = [
  showingSettings,
  showingAdd,
  showingDecide,
  showingCheck,
  showingFeedback,
  showingShare,
  publicShowingRequest,
  publicShowingFeedback,
  portalShowingAnswer,
  showingSent,
  showingFromEmail,
  showingThemesSaved,
];
export const showingQueries = [
  showingList,
  publicShowingTimes,
  publicShowingFeedbackForm,
  portalShowings,
];
