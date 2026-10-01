/**
 * Open houses, step 7 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core"). Chris decided
 * (2026-10-01): visitors sign in on a page they open from a QR code.
 *
 * - **Planning one** puts it on the host's calendar as a tour is (a private deal's shows only as busy to others), and
 *   says the listing has open houses, so S-36 to S-39 open. The seller sees it in their portal; no sign-off needed.
 * - **The sign-in page** (`/a/<site>/realestate/<slug>/open-house/<id>`) opens an hour before and closes an hour after,
 *   and only once the listing is live on the MLS. A visitor on their own becomes a customer with a lead for the host,
 *   their yes to texts kept with "Open house: 2207 Juniper Trail"; one working with another agent is only recorded.
 * - **Following up**: the host marks each visitor followed up; the worker reminds them the next morning.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { bookingSites } from '@hfos/db/schema';
import { appointmentCancel, appointmentCreate } from '../../../commands/appointment';
import { signUpFromPage, SIGN_UP_EVENTS } from '../../../crm/signup';
import { HfosError } from '../../../errors';
import { requirePublic } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { QueryContext } from '../../../kernel/types';
import { fmtAt } from '../../../calendar/when';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { listingPagePath, streetOf } from '../listing';
import { realestateAddon } from '../manifest';
import {
  ListingInput,
  OpenHouseCancelInput,
  OpenHouseChangeOutput,
  OpenHouseFollowUpInput,
  OpenHouseFollowUpOutput,
  OpenHousePlanInput,
  OpenHousePlanOutput,
  OpenHousesOutput,
  PublicOpenHouseInput,
  PublicOpenHouseOutput,
  PublicOpenHouseSignInInput,
  PublicOpenHouseSignInOutput,
} from '../schemas';
import { listings, openHouses, openHouseVisitors } from '../tables';
import {
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireOpen,
  timeZoneOf,
  userNames,
  type Ctx,
} from './common';
import { dealSetFacts } from './deals';
import { ensureListing, listingAddress, listingOf, requireListingSide } from './listing';
import { publicPhotos } from './marketing';
import { addProof, PROOF_EVENTS, withdrawProof } from './proof-hooks';
import { tourCalendar } from './tours';

type OpenHouse = typeof openHouses.$inferSelect;
const HOUR = 3_600_000;

/** When sign-in opens and closes: an hour either side. */
export const signInWindow = (o: Pick<OpenHouse, 'startsAt' | 'endsAt'>) => ({
  opensAt: new Date(o.startsAt.getTime() - HOUR),
  closesAt: new Date(o.endsAt.getTime() + HOUR),
});

async function loadOpenHouse(ctx: Ctx, id: string, lock = false): Promise<OpenHouse> {
  const q = ctx.tx
    .select()
    .from(openHouses)
    .where(and(eq(openHouses.id, id), eq(openHouses.workspaceId, ctx.scope.workspaceId!)));
  const [o] = lock ? await q.for('update') : await q;
  if (!o)
    throw HfosError.notFound(
      'That open house isn’t there anymore. Refresh to see the listing’s open houses.',
    );
  return o;
}

async function siteSlugOf(ctx: Ctx): Promise<string | null> {
  const [s] = await ctx.tx
    .select({ slug: bookingSites.slug })
    .from(bookingSites)
    .where(eq(bookingSites.workspaceId, ctx.scope.workspaceId!));
  return s ? String(s.slug) : null;
}

/** The sign-in page's address: the listing's page and the open house. */
export const openHousePath = (site: string, slug: string, id: string) =>
  `${listingPagePath(site, slug)}/open-house/${id}`;

// ---------- the team's ----------

export const openHousePlan = defineAddonCommand(realestateAddon, {
  name: 'realestate.open_house.plan',
  description:
    'Plan an open house for a listing: it goes on the host’s calendar, the seller sees it in their portal, and its sign-in page opens an hour before it starts once the listing is live on the MLS.',
  risk: 1,
  input: OpenHousePlanInput,
  output: OpenHousePlanOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_plan_open_house',
    description: 'Plan an open house for a listing on the host’s calendar. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.open_house.planned', 'realestate.deal.facts_changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    await ensureListing(ctx, deal);
    const address = await listingAddress(ctx, deal);
    if (!address)
      throw HfosError.rule(
        'realestate_listing_no_address',
        409,
        `${deal.name} has no home on it yet. Add the home’s address on the deal’s page first.`,
      );
    const me = actorUserId(ctx);
    const hostId = input.hostUserId ?? me;
    if (!hostId)
      throw HfosError.validation(
        [{ path: 'hostUserId', message: 'Pick who hosts it.' }],
        'Pick who hosts it.',
      );
    const names = await userNames(ctx, [hostId]);
    const hostName = names.get(hostId) ?? 'That person';
    if (hostId !== me && hostId !== deal.ownerUserId && !deal.teamUserIds.includes(hostId))
      throw HfosError.rule(
        'realestate_open_house_host_off_deal',
        409,
        `${hostName} isn’t on ${deal.name}. Add them to the deal’s team first, or host it yourself.`,
      );
    const calendarId = await tourCalendar(ctx, input.calendarId, hostId, hostName);
    const street = streetOf(address);
    const booked = await executeCommandWithin(ctx, appointmentCreate, {
      workspaceId: deal.workspaceId,
      calendarId,
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes,
      userIds: [hostId],
      personId: null,
      title: `Open house: ${street}`.slice(0, 200),
      notes: null,
      location: { kind: null, address, meetingUrl: null, postalCode: null },
      customRecordId: deal.recordId,
      acknowledgeWarnings: input.acknowledgeWarnings,
      notify: false,
    });
    const [o] = await ctx.tx
      .insert(openHouses)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        startsAt: new Date(booked.output.startsAt),
        endsAt: new Date(booked.output.endsAt),
        hostUserId: hostId,
        appointmentId: booked.output.appointmentId,
        calendarId,
        createdBy: me,
      })
      .returning();
    // The listing has open houses: S-36 to S-39 open.
    if (!deal.facts.includes('open_house'))
      await executeCommandWithin(ctx, dealSetFacts, {
        workspaceId: deal.workspaceId,
        dealId: deal.recordId,
        facts: [...deal.facts, 'open_house'],
      });
    const when = fmtAt(booked.output.startsAt, await timeZoneOf(ctx));
    await historyLine(ctx, deal, 'open_house_planned', { after: { when, host: hostName } });
    // S-36 "Schedule open house": its appointment.
    await addProof(
      ctx,
      await loadDeal(ctx, deal.recordId),
      { keys: ['S-36'] },
      {
        kind: 'appointment',
        appointmentId: booked.output.appointmentId,
        body: `Open house on ${when}, hosted by ${hostName}`,
      },
    );
    await ctx.emit({
      type: 'realestate.open_house.planned',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        openHouseId: o!.id,
        endsAt: booked.output.endsAt,
        hostUserId: hostId,
        street,
      },
      after: { when },
    });
    return {
      openHouseId: o!.id,
      appointmentId: booked.output.appointmentId,
      startsAt: booked.output.startsAt,
      endsAt: booked.output.endsAt,
      warnings: booked.output.warnings.map((w) => ({ code: w.code, message: w.message })),
    };
  },
});

export const openHouseCancel = defineAddonCommand(realestateAddon, {
  name: 'realestate.open_house.cancel',
  description:
    'Cancel a planned open house: its appointment comes off the calendar and its sign-in page closes.',
  risk: 1,
  input: OpenHouseCancelInput,
  output: OpenHouseChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.open_house.cancelled', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const o = await loadOpenHouse(ctx, input.openHouseId, true);
    const deal = await loadDeal(ctx, o.dealRecordId, { lock: true });
    if (o.state === 'cancelled') return { openHouseId: o.id, state: o.state };
    if (o.appointmentId)
      await executeCommandWithin(ctx, appointmentCancel, {
        workspaceId: deal.workspaceId,
        appointmentId: o.appointmentId,
        reason: input.reason ?? null,
        notify: false,
      }).catch((e: unknown) => {
        // Already off the calendar: the open house is cancelled all the same.
        if (!(e instanceof HfosError)) throw e;
      });
    await ctx.tx
      .update(openHouses)
      .set({
        state: 'cancelled',
        cancelledAt: changeMoment(ctx.meta),
        cancelledReason: input.reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(openHouses.id, o.id));
    const when = fmtAt(o.startsAt.getTime(), await timeZoneOf(ctx));
    await historyLine(ctx, deal, 'open_house_cancelled', {
      after: { when },
      note: input.reason ?? null,
    });
    if (o.appointmentId)
      await withdrawProof(
        ctx,
        deal,
        { appointmentId: o.appointmentId },
        'The open house was cancelled.',
      );
    await ctx.emit({
      type: 'realestate.open_house.cancelled',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { openHouseId: o.id },
    });
    return { openHouseId: o.id, state: 'cancelled' as const };
  },
});

export const openHouseFollowUp = defineAddonCommand(realestateAddon, {
  name: 'realestate.open_house.follow_up',
  description:
    'Mark an open house visitor followed up, with a note. When everyone is, the reminder clears; it’s proof for S-39.',
  risk: 1,
  input: OpenHouseFollowUpInput,
  output: OpenHouseFollowUpOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.open_house.followed_up', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const [v] = await ctx.tx
      .select()
      .from(openHouseVisitors)
      .where(
        and(
          eq(openHouseVisitors.id, input.visitorId),
          eq(openHouseVisitors.workspaceId, ctx.scope.workspaceId!),
        ),
      )
      .for('update');
    if (!v)
      throw HfosError.notFound('That visitor isn’t there anymore. Refresh to see the open house.');
    const deal = await loadDeal(ctx, v.dealRecordId);
    if (v.followedUpAt) return { visitorId: v.id, followedUpAt: v.followedUpAt.toISOString() };
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(openHouseVisitors)
      .set({ followedUpAt: at, followedUpBy: actorUserId(ctx), followUpNote: input.note ?? null })
      .where(eq(openHouseVisitors.id, v.id));
    // S-39 "Follow up with open-house visitors".
    await addProof(
      ctx,
      deal,
      { keys: ['S-39'] },
      {
        kind: 'record',
        refKind: 'open_house_visitor',
        refId: v.id,
        body: `Followed up with ${v.firstName}${input.note ? `: ${input.note}` : ''}`,
      },
    );
    await ctx.emit({
      type: 'realestate.open_house.followed_up',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { openHouseId: v.openHouseId, visitorId: v.id },
      broadcast: false,
    });
    return { visitorId: v.id, followedUpAt: at.toISOString() };
  },
});

export const openHousesList = defineAddonQuery(realestateAddon, {
  name: 'realestate.open_houses',
  description:
    'A listing’s open houses: when, who hosts, the sign-in page, and who signed in, with whether they’re working with an agent, agreed to texts and have been followed up.',
  input: ListingInput,
  output: OpenHousesOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireListingSide(deal);
    const l = await listingOf(ctx, deal.recordId);
    const live = !!l?.mlsNumber;
    const site = live && l?.slug ? await siteSlugOf(ctx) : null;
    const list = await ctx.tx
      .select()
      .from(openHouses)
      .where(eq(openHouses.dealRecordId, deal.recordId))
      .orderBy(asc(openHouses.startsAt));
    const visitors = list.length
      ? await ctx.tx
          .select()
          .from(openHouseVisitors)
          .where(
            inArray(
              openHouseVisitors.openHouseId,
              list.map((o) => o.id),
            ),
          )
          .orderBy(asc(openHouseVisitors.signedInAt))
      : [];
    const names = await userNames(
      ctx,
      list.map((o) => o.hostUserId),
    );
    return {
      dealId: deal.recordId,
      live,
      openHouses: list.map((o) => ({
        id: o.id,
        startsAt: o.startsAt.toISOString(),
        endsAt: o.endsAt.toISOString(),
        state: o.state,
        host: o.hostUserId
          ? { id: o.hostUserId, fullName: names.get(o.hostUserId) ?? 'Former member' }
          : null,
        signInPath:
          site && l?.slug && o.state === 'planned' ? openHousePath(site, l.slug, o.id) : null,
        visitors: visitors
          .filter((v) => v.openHouseId === o.id)
          .map((v) => ({
            id: v.id,
            firstName: v.firstName,
            lastName: v.lastName,
            email: v.email,
            phone: v.phone,
            withAgent: v.withAgent,
            agentName: v.agentName,
            smsConsent: v.smsConsent,
            signedInAt: v.signedInAt.toISOString(),
            personId: v.personId,
            followedUpAt: v.followedUpAt?.toISOString() ?? null,
          })),
      })),
    };
  },
});

// ---------- the visitor's ----------

/** The open house a visitor's page is for: planned, of a listing live on the MLS with a page address. */
async function publicOpenHouse(ctx: Ctx, slug: string, openHouseId: string) {
  const notHere = () =>
    HfosError.notFound(
      'There’s no open house at this address. Check the link on the sign-in sheet, or ask the host.',
    );
  const [l] = await ctx.tx
    .select()
    .from(listings)
    .where(
      and(eq(listings.workspaceId, ctx.scope.workspaceId!), eq(listings.slug, slug.toLowerCase())),
    );
  if (!l?.mlsNumber) throw notHere();
  const o = await loadOpenHouse(ctx, openHouseId).catch(() => null);
  if (!o || o.dealRecordId !== l.dealRecordId) throw notHere();
  const deal = await loadDeal(ctx, l.dealRecordId).catch(() => null);
  if (!deal || deal.archivedAt) throw notHere();
  const address = await listingAddress(ctx, deal);
  if (!address) throw notHere();
  return { l, o, deal, address };
}

export const publicOpenHouseGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.public.open_house',
  description:
    'An open house’s sign-in page: the home, when, its host, and whether sign-in is open.',
  input: PublicOpenHouseInput,
  output: PublicOpenHouseOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  async handler(ctx: QueryContext, input) {
    requirePublic(ctx);
    const { o, deal, address } = await publicOpenHouse(ctx, input.slug, input.openHouseId);
    const { opensAt, closesAt } = signInWindow(o);
    const now = Date.now();
    const names = await userNames(ctx, [o.hostUserId]);
    const [first] = await publicPhotos(ctx, deal.recordId);
    return {
      street: streetOf(address),
      cityLine: address.split(',').slice(1).join(',').trim() || null,
      startsAt: o.startsAt.toISOString(),
      endsAt: o.endsAt.toISOString(),
      hostName: o.hostUserId ? (names.get(o.hostUserId) ?? null) : null,
      opensAt: opensAt.toISOString(),
      closesAt: closesAt.toISOString(),
      open: o.state === 'planned' && now >= opensAt.getTime() && now <= closesAt.getTime(),
      cancelled: o.state === 'cancelled',
      photo: first ? { publicFileId: first.fileId } : null,
    };
  },
});

export const publicOpenHouseSignIn = defineAddonCommand(realestateAddon, {
  name: 'realestate.public.open_house.sign_in',
  description:
    'A visitor signs in at an open house. On their own, they become a customer with a lead for the host, their yes to texts kept; working with another agent, they’re only recorded.',
  risk: 2,
  input: PublicOpenHouseSignInInput,
  output: PublicOpenHouseSignInOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  emits: ['realestate.open_house.signed_in', ...SIGN_UP_EVENTS, ...PROOF_EVENTS],
  async handler(ctx, input) {
    requirePublic(ctx);
    const { o, deal, address } = await publicOpenHouse(ctx, input.slug, input.openHouseId);
    const { opensAt, closesAt } = signInWindow(o);
    const tz = await timeZoneOf(ctx);
    const now = Date.now();
    if (o.state === 'cancelled')
      throw HfosError.rule(
        'realestate_open_house_cancelled',
        409,
        'This open house was cancelled.',
      );
    if (now < opensAt.getTime() || now > closesAt.getTime())
      throw HfosError.rule(
        'realestate_open_house_closed',
        409,
        now < opensAt.getTime()
          ? `Sign-in opens at ${fmtAt(opensAt.getTime(), tz)}. Come back then.`
          : 'Sign-in for this open house has closed. Ask the agent if you’d like to see the home.',
      );
    const street = streetOf(address);
    const signed = input.withAgent
      ? null
      : await signUpFromPage(ctx, {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          source: `Open house: ${street}`,
          smsConsent: input.smsConsent,
          lead: { title: `Open house: ${street}`, assigneeUserId: o.hostUserId },
        });
    const values = {
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      openHouseId: o.id,
      personId: signed?.personId ?? null,
      leadId: signed?.leadId ?? null,
      firstName: input.firstName,
      lastName: input.lastName || null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      withAgent: input.withAgent,
      agentName: input.withAgent ? (input.agentName ?? null) : null,
      smsConsent: !input.withAgent && input.smsConsent,
    };
    // Signing in twice is one visit.
    const [v] = signed
      ? await ctx.tx
          .insert(openHouseVisitors)
          .values(values)
          .onConflictDoUpdate({
            target: [openHouseVisitors.openHouseId, openHouseVisitors.personId],
            set: { signedInAt: new Date(), smsConsent: values.smsConsent },
          })
          .returning({ id: openHouseVisitors.id })
      : await ctx.tx
          .insert(openHouseVisitors)
          .values(values)
          .returning({ id: openHouseVisitors.id });
    // S-38 "Register open-house visitors": who signed in.
    await addProof(
      ctx,
      deal,
      { keys: ['S-38'] },
      {
        kind: 'record',
        refKind: 'open_house',
        refId: o.id,
        body: `Visitors signed in at the open house on ${fmtAt(o.startsAt.getTime(), tz)}`,
      },
    );
    await ctx.emit({
      type: 'realestate.open_house.signed_in',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { openHouseId: o.id, visitorId: v!.id, withAgent: input.withAgent },
      broadcast: false,
    });
    return { signedIn: true as const, firstName: input.firstName };
  },
});

export const openHouseQueries = [openHousesList, publicOpenHouseGet] as const;
export const openHouseCommands = [
  openHousePlan,
  openHouseCancel,
  openHouseFollowUp,
  publicOpenHouseSignIn,
] as const;
