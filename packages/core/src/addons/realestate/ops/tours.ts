/**
 * Tours, step 8 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core").
 *
 * - **A tour is an appointment.** Planning one books it on the core calendar (`appointment.create`, in the same
 *   transaction) for the agent who leads it, with the deal's client invited and the homes in order. The appointment
 *   is the deal's, so someone off a private deal sees only that the agent is busy (step 1). Moving or canceling the
 *   tour moves or cancels the appointment; moving or canceling the appointment on the calendar moves or cancels the
 *   tour (the worker, `realestate.tour.follow`).
 * - **The agreement rule** (Chris, 2026-09-30): a tour needs a signed buyer agreement that hasn't ended by the
 *   tour's day. Refused otherwise (`buyer_agreement_needed`, `buyer_agreement_expired`), unless an owner or admin
 *   (Approve exceptions) lets it through with a reason, which is kept on the tour and in the deal's history. The AI
 *   never makes that exception.
 * - **After the tour**, the agent marks each home seen or skipped, and what each client thought of the homes they
 *   saw is kept, theirs from the portal (step 12) or as the agent heard it.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  appointmentCancel,
  appointmentCreate,
  appointmentReschedule,
  appointmentUpdate,
} from '../../../commands/appointment';
import { fmtAt, localDayOf } from '../../../calendar/when';
import { HfosError } from '../../../errors';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  TourCancelInput,
  TourChangeOutput,
  TourFeedbackInput,
  TourFeedbackOutput,
  TourFollowInput,
  TourFollowOutput,
  TourPlanInput,
  TourPlanOutput,
  TourRecordVisitInput,
  TourRecordVisitOutput,
  TourRescheduleInput,
  ToursInput,
  ToursOutput,
  TourSetStopsInput,
} from '../schemas';
import { documents, homes, tourFeedback, tours, tourStops } from '../tables';
import {
  agreementEndsOn,
  agreementOut,
  agreementState,
  agreementWords,
  defaultTourMinutes,
  TOUR_INTEREST,
  tourNotes,
  tourOut,
  tourTitle,
  type AgreementFacts,
} from '../tours';
import {
  actorKind,
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireOpen,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { termEntriesOf } from './engine';
import { loadHome, refuseFairHousingWords, requireBuyerSide } from './homes';
import { addProof, PROOF_EVENTS, withdrawProof } from './proof-hooks';

type Tour = typeof tours.$inferSelect;
type Stop = typeof tourStops.$inferSelect;
type Home = typeof homes.$inferSelect;

// ---------- the agreement ----------

/** The deal's signed buyer agreement and when it ends, as the rule reads them. */
export async function agreementFactsOf(ctx: Ctx, dealId: string): Promise<AgreementFacts> {
  const [doc] = await ctx.tx
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.dealRecordId, dealId),
        eq(documents.kind, 'buyer_agreement'),
        eq(documents.status, 'signed'),
      ),
    )
    .orderBy(desc(documents.controlling), desc(documents.signedAt), desc(documents.id))
    .limit(1);
  return {
    signed: doc ? { documentId: doc.id, title: doc.title } : null,
    endsOn: agreementEndsOn(await termEntriesOf(ctx, dealId)),
  };
}

interface Gate {
  readonly documentId: string | null;
  readonly exception: { readonly reason: string } | null;
}

/**
 * A tour on `startsAt` may go ahead: on a signed agreement that covers its day, or on an owner's or admin's
 * exception with a reason. Refused otherwise, saying what to do.
 */
async function agreementGate(
  ctx: CommandContext,
  deal: Deal,
  startsAt: string,
  timeZone: string,
  exception: { readonly reason: string } | undefined,
): Promise<Gate> {
  const facts = await agreementFactsOf(ctx, deal.recordId);
  const tourDate = localDayOf(startsAt, timeZone);
  const state = agreementState(facts, tourDate);
  if (state.ok) return { documentId: state.documentId, exception: null };
  if (!exception) throw HfosError.rule(state.rule, 409, agreementWords(state, deal.name, tourDate));
  if (actorKind(ctx) !== 'person')
    throw HfosError.forbidden(
      'Only an owner or admin can let a tour through without a signed, current buyer agreement, from the deal’s page.',
      'realestate_tour_exception_person',
    );
  if (!scopeCan(ctx.scope, 'realestate.except' as Permission))
    throw HfosError.forbidden(
      'Only an owner or admin (Approve exceptions) can let a tour through without a signed, current buyer agreement. Ask one of them.',
      'realestate_tour_exception_permission',
    );
  return { documentId: facts.signed?.documentId ?? null, exception };
}

// ---------- shared ----------

/** The deal's homes for a tour, in the order given. */
async function homesInOrder(ctx: Ctx, deal: Deal, homeIds: readonly string[]): Promise<Home[]> {
  const list = await ctx.tx
    .select()
    .from(homes)
    .where(and(eq(homes.dealRecordId, deal.recordId), inArray(homes.id, [...homeIds])));
  const byId = new Map(list.map((h) => [h.id, h]));
  return homeIds.map((id) => {
    const h = byId.get(id);
    if (!h)
      throw HfosError.notFound(
        `One of those homes isn’t on ${deal.name} anymore. Refresh to see its homes as they are now.`,
      );
    if (h.status === 'removed')
      throw HfosError.rule(
        'realestate_tour_home_removed',
        409,
        `${h.address} was removed from ${deal.name}. Put it back on the deal’s homes first, or leave it off the tour.`,
      );
    return h;
  });
}

/** The deal's client to invite: the first one with an email or phone, else the first. */
async function clientToInvite(ctx: Ctx, dealId: string): Promise<string | null> {
  const [c] = await rows<{ id: string }>(
    ctx.tx,
    sql`select p.id from app.relationships rel
        join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
        join app.people p on p.id = rel.a_person_id
        where rel.b_custom_record_id = ${dealId}
        order by (p.email is null and p.phone is null), rel.created_at limit 1`,
  );
  return c?.id ?? null;
}

/** The deal's clients, by id. */
async function clientsOf(ctx: Ctx, dealId: string): Promise<ReadonlyMap<string, string>> {
  const list = await rows<{ id: string; name: string }>(
    ctx.tx,
    sql`select p.id, btrim(concat_ws(' ', p.first_name, p.last_name)) as name from app.relationships rel
        join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
        join app.people p on p.id = rel.a_person_id
        where rel.b_custom_record_id = ${dealId}`,
  );
  return new Map(list.map((c) => [c.id, c.name || 'The client']));
}

/**
 * The calendar the tour goes on: the one asked for, else the business's tour calendar (Settings → Real Estate),
 * else the one active calendar the agent is on.
 */
export async function tourCalendar(
  ctx: Ctx,
  asked: string | undefined,
  agentId: string,
  agentName: string,
): Promise<string> {
  if (asked) return asked;
  const [set] = await rows<{ id: string | null }>(
    ctx.tx,
    sql`select settings ->> 'tourCalendarId' as id from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'realestate'`,
  );
  if (set?.id) return set.id;
  const theirs = await rows<{ id: string }>(
    ctx.tx,
    sql`select c.id from app.calendars c
        join app.calendar_members m on m.calendar_id = c.id and m.user_id = ${agentId}
        where c.workspace_id = ${ctx.scope.workspaceId!} and c.status = 'active'
        order by c.created_at limit 2`,
  );
  if (theirs.length === 1) return theirs[0]!.id;
  throw HfosError.rule(
    'realestate_tour_calendar',
    409,
    theirs.length
      ? `${agentName} is on more than one calendar. Pick the one tours go on in Settings → Real Estate.`
      : `${agentName} isn’t on any calendar yet. Add them to one in Settings → Calendars, then pick it for tours in Settings → Real Estate.`,
  );
}

async function loadTour(ctx: Ctx, tourId: string, opts: { lock?: boolean } = {}): Promise<Tour> {
  const q = ctx.tx
    .select()
    .from(tours)
    .where(and(eq(tours.id, tourId), eq(tours.workspaceId, ctx.scope.workspaceId!)));
  const [t] = opts.lock ? await q.for('update') : await q;
  if (!t)
    throw HfosError.notFound(
      'That tour isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s tours.',
    );
  return t;
}

function requirePlanned(t: Tour, tz: string): void {
  if (t.status !== 'planned')
    throw HfosError.rule(
      'realestate_tour_settled',
      409,
      t.status === 'canceled'
        ? `The tour on ${fmtAt(t.startsAt.getTime(), tz)} was canceled. Plan a new one instead.`
        : `The tour on ${fmtAt(t.startsAt.getTime(), tz)} is done. Plan a new one instead.`,
    );
}

async function stopsOf(ctx: Ctx, tourId: string): Promise<Stop[]> {
  return ctx.tx
    .select()
    .from(tourStops)
    .where(eq(tourStops.tourId, tourId))
    .orderBy(asc(tourStops.position));
}

async function putStops(
  ctx: CommandContext,
  t: Pick<Tour, 'id' | 'dealRecordId'>,
  list: readonly Home[],
) {
  await ctx.tx.delete(tourStops).where(eq(tourStops.tourId, t.id));
  await ctx.tx.insert(tourStops).values(
    list.map((h, i) => ({
      workspaceId: ctx.scope.workspaceId!,
      dealRecordId: t.dealRecordId,
      tourId: t.id,
      homeId: h.id,
      position: i + 1,
    })),
  );
}

const changeOut = (t: Pick<Tour, 'id' | 'status' | 'startsAt' | 'endsAt'>) => ({
  tourId: t.id,
  status: t.status,
  startsAt: t.startsAt.toISOString(),
  endsAt: t.endsAt.toISOString(),
});

// ---------- commands ----------

export const tourPlan = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.plan',
  description:
    'Plan a tour of a buyer’s homes: one appointment on the calendar with the homes in order, the client invited. Needs a signed buyer agreement that covers the day, unless an owner or admin makes an exception with a reason.',
  risk: 2,
  input: TourPlanInput,
  output: TourPlanOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_plan_tour',
    description:
      'Plan a home tour on a buyer deal: the homes in order, the day and time. A person OKs it first.',
  },
  emits: ['realestate.tour.planned', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireBuyerSide(deal);
    const list = await homesInOrder(ctx, deal, input.homeIds);
    if (input.note) refuseFairHousingWords([input.note]);
    const tz = await timeZoneOf(ctx);
    const me = actorUserId(ctx);
    const agentId = input.agentUserId ?? me;
    if (!agentId)
      throw HfosError.validation(
        [{ path: 'agentUserId', message: 'Pick who leads the tour.' }],
        'Pick who leads the tour.',
      );
    const names = await userNames(ctx, [agentId]);
    const agentName = names.get(agentId) ?? 'That person';
    if (agentId !== me && agentId !== deal.ownerUserId && !deal.teamUserIds.includes(agentId))
      throw HfosError.rule(
        'realestate_tour_agent_off_deal',
        409,
        `${agentName} isn’t on ${deal.name}. Add them to the deal’s team first, or lead the tour yourself.`,
      );
    const gate = await agreementGate(ctx, deal, input.startsAt, tz, input.exception);
    const calendarId = await tourCalendar(ctx, input.calendarId, agentId, agentName);
    const client = await clientToInvite(ctx, deal.recordId);
    const addresses = list.map((h) => h.address);
    const booked = await executeCommandWithin(ctx, appointmentCreate, {
      workspaceId: deal.workspaceId,
      calendarId,
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes ?? defaultTourMinutes(list.length),
      userIds: [agentId],
      personId: client,
      title: tourTitle(addresses),
      notes: tourNotes(addresses, input.note),
      location: { kind: null, address: addresses[0]!, meetingUrl: null, postalCode: null },
      customRecordId: deal.recordId,
      acknowledgeWarnings: input.acknowledgeWarnings,
      notify: input.notifyClient && client !== null,
    });
    const at = changeMoment(ctx.meta);
    const [tour] = await ctx.tx
      .insert(tours)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        appointmentId: booked.output.appointmentId,
        calendarId,
        startsAt: new Date(booked.output.startsAt),
        endsAt: new Date(booked.output.endsAt),
        agentUserId: agentId,
        agreementDocumentId: gate.documentId,
        ...(gate.exception
          ? { exceptionReason: gate.exception.reason, exceptionBy: me, exceptionAt: at }
          : {}),
        note: input.note ?? null,
        createdBy: me,
      })
      .returning();
    await putStops(ctx, tour!, list);
    const when = fmtAt(booked.output.startsAt, tz);
    await historyLine(ctx, deal, 'tour_planned', {
      after: { when, homes: list.length, first: addresses[0] },
    });
    if (gate.exception)
      await historyLine(ctx, deal, 'tour_exception', {
        after: { when },
        note: gate.exception.reason,
      });
    // B-05 "Schedule showings" (and B-14 after a lost offer): the tour is its appointment.
    await addProof(
      ctx,
      deal,
      { keys: ['B-05', 'B-14'] },
      {
        kind: 'appointment',
        appointmentId: booked.output.appointmentId,
        body: `Tour on ${when}: ${addresses.join('; ')}`,
      },
    );
    await ctx.emit({
      type: 'realestate.tour.planned',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        tourId: tour!.id,
        appointmentId: booked.output.appointmentId,
        homes: list.length,
        exception: gate.exception !== null,
      },
      after: { when, homes: addresses },
    });
    return {
      tourId: tour!.id,
      appointmentId: booked.output.appointmentId,
      startsAt: booked.output.startsAt,
      endsAt: booked.output.endsAt,
      warnings: booked.output.warnings.map((w) => ({ code: w.code, message: w.message })),
      exception: gate.exception !== null,
    };
  },
});

export const tourSetStops = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.set_stops',
  description: 'Change which homes a planned tour sees, and in what order.',
  risk: 1,
  input: TourSetStopsInput,
  output: TourChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.tour.stops_changed'],
  async handler(ctx, input) {
    const t = await loadTour(ctx, input.tourId, { lock: true });
    const deal = await loadDeal(ctx, t.dealRecordId);
    requireOpen(deal);
    const tz = await timeZoneOf(ctx);
    requirePlanned(t, tz);
    if ((await stopsOf(ctx, t.id)).some((s) => s.status !== 'planned'))
      throw HfosError.rule(
        'realestate_tour_underway',
        409,
        'Some homes on this tour are already marked seen or skipped, so its homes stay as they are. Plan another tour for the rest.',
      );
    const list = await homesInOrder(ctx, deal, input.homeIds);
    await putStops(ctx, t, list);
    const addresses = list.map((h) => h.address);
    if (t.appointmentId)
      await executeCommandWithin(ctx, appointmentUpdate, {
        workspaceId: deal.workspaceId,
        appointmentId: t.appointmentId,
        title: tourTitle(addresses),
        notes: tourNotes(addresses, t.note),
        location: { kind: null, address: addresses[0]!, meetingUrl: null, postalCode: null },
      });
    await ctx.tx.update(tours).set({ updatedAt: new Date() }).where(eq(tours.id, t.id));
    await historyLine(ctx, deal, 'tour_stops', {
      after: { when: fmtAt(t.startsAt.getTime(), tz), homes: list.length },
    });
    await ctx.emit({
      type: 'realestate.tour.stops_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { tourId: t.id, homes: list.length },
      after: { homes: addresses },
    });
    return changeOut(t);
  },
});

export const tourReschedule = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.reschedule',
  description:
    'Move a planned tour to another time, and its appointment with it. The buyer agreement must cover the new day too, unless an owner or admin already let this tour through.',
  risk: 2,
  input: TourRescheduleInput,
  output: TourChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.tour.rescheduled'],
  async handler(ctx, input) {
    const t = await loadTour(ctx, input.tourId, { lock: true });
    const deal = await loadDeal(ctx, t.dealRecordId);
    requireOpen(deal);
    const tz = await timeZoneOf(ctx);
    requirePlanned(t, tz);
    if (!t.appointmentId)
      throw HfosError.rule(
        'realestate_tour_no_appointment',
        409,
        'This tour’s appointment was deleted from the calendar. Cancel the tour and plan a new one.',
      );
    // A tour an owner or admin already let through stays let through when it moves.
    const gate: Gate =
      t.exceptionAt && t.exceptionReason && !input.exception
        ? { documentId: null, exception: null }
        : await agreementGate(ctx, deal, input.startsAt, tz, input.exception);
    const moved = await executeCommandWithin(ctx, appointmentReschedule, {
      workspaceId: deal.workspaceId,
      appointmentId: t.appointmentId,
      startsAt: input.startsAt,
      ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
      acknowledgeWarnings: input.acknowledgeWarnings,
      notify: input.notifyClient,
    });
    const at = changeMoment(ctx.meta);
    const [next] = await ctx.tx
      .update(tours)
      .set({
        startsAt: new Date(moved.output.startsAt),
        endsAt: new Date(moved.output.endsAt),
        updatedAt: new Date(),
        ...(gate.documentId ? { agreementDocumentId: gate.documentId } : {}),
        ...(gate.exception
          ? {
              exceptionReason: gate.exception.reason,
              exceptionBy: actorUserId(ctx),
              exceptionAt: at,
            }
          : {}),
      })
      .where(eq(tours.id, t.id))
      .returning();
    const from = fmtAt(t.startsAt.getTime(), tz);
    const to = fmtAt(moved.output.startsAt, tz);
    await historyLine(ctx, deal, 'tour_moved', { before: { when: from }, after: { when: to } });
    if (gate.exception)
      await historyLine(ctx, deal, 'tour_exception', {
        after: { when: to },
        note: gate.exception.reason,
      });
    await ctx.emit({
      type: 'realestate.tour.rescheduled',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { tourId: t.id, exception: gate.exception !== null },
      before: { when: from },
      after: { when: to },
    });
    return changeOut(next!);
  },
});

export const tourCancel = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.cancel',
  description: 'Cancel a planned tour, and its appointment, telling the client if asked.',
  risk: 2,
  input: TourCancelInput,
  output: TourChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.tour.canceled', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const t = await loadTour(ctx, input.tourId, { lock: true });
    const deal = await loadDeal(ctx, t.dealRecordId);
    const tz = await timeZoneOf(ctx);
    if (t.status === 'canceled') return changeOut(t);
    requirePlanned(t, tz);
    if (t.appointmentId) {
      const [appt] = await rows<{ status: string }>(
        ctx.tx,
        sql`select status::text from app.appointments where id = ${t.appointmentId}`,
      );
      if (appt?.status === 'scheduled')
        await executeCommandWithin(ctx, appointmentCancel, {
          workspaceId: deal.workspaceId,
          appointmentId: t.appointmentId,
          reason: input.reason ?? null,
          notify: input.notifyClient,
        });
    }
    const [next] = await ctx.tx
      .update(tours)
      .set({
        status: 'canceled',
        canceledAt: changeMoment(ctx.meta),
        canceledReason: input.reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(tours.id, t.id))
      .returning();
    const when = fmtAt(t.startsAt.getTime(), tz);
    await historyLine(ctx, deal, 'tour_canceled', { after: { when }, note: input.reason ?? null });
    if (t.appointmentId)
      await withdrawProof(ctx, deal, { appointmentId: t.appointmentId }, 'The tour was canceled.');
    await ctx.emit({
      type: 'realestate.tour.canceled',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { tourId: t.id, by: 'staff' },
      after: { when, reason: input.reason ?? null },
    });
    return changeOut(next!);
  },
});

async function loadStop(ctx: Ctx, stopId: string): Promise<Stop> {
  const [s] = await ctx.tx
    .select()
    .from(tourStops)
    .where(and(eq(tourStops.id, stopId), eq(tourStops.workspaceId, ctx.scope.workspaceId!)));
  if (!s)
    throw HfosError.notFound(
      'That home isn’t on the tour anymore. Refresh to see the tour as it is now.',
    );
  return s;
}

export const tourRecordVisit = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.record_visit',
  description:
    'Mark a home on a tour seen or skipped, with a note for the team. Once every home is, the tour is done.',
  risk: 1,
  input: TourRecordVisitInput,
  output: TourRecordVisitOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // At each stop, with no signal (board 83): seen when it was marked, by the phone's clock.
  offline: 'anytime',
  emits: ['realestate.tour.visited', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const stop = await loadStop(ctx, input.stopId);
    const t = await loadTour(ctx, stop.tourId, { lock: true });
    const deal = await loadDeal(ctx, t.dealRecordId);
    requireOpen(deal);
    const tz = await timeZoneOf(ctx);
    if (t.status === 'canceled') requirePlanned(t, tz);
    const at = changeMoment(ctx.meta);
    // Within the hour before it starts at the earliest: a tour that hasn't begun has nothing seen yet.
    if (at.getTime() < t.startsAt.getTime() - 60 * 60_000)
      throw HfosError.rule(
        'realestate_tour_not_yet',
        409,
        `That tour starts ${fmtAt(t.startsAt.getTime(), tz)}. Mark homes seen once it’s underway.`,
      );
    if (input.note) refuseFairHousingWords([input.note]);
    const home = await loadHome(ctx, stop.homeId);
    await ctx.tx
      .update(tourStops)
      .set({
        status: input.status,
        visitedAt: input.status === 'visited' ? (stop.visitedAt ?? at) : null,
        note: input.note ?? stop.note,
        updatedAt: new Date(),
      })
      .where(eq(tourStops.id, stop.id));
    if (input.status === 'visited' && (home.status === 'saved' || home.status === 'shortlisted'))
      await ctx.tx
        .update(homes)
        .set({ status: 'toured', updatedAt: new Date() })
        .where(eq(homes.id, home.id));
    const left = (await stopsOf(ctx, t.id)).filter((s) => s.status === 'planned').length;
    const tourStatus = left === 0 && t.status === 'planned' ? 'done' : t.status;
    if (tourStatus !== t.status)
      await ctx.tx
        .update(tours)
        .set({ status: tourStatus, updatedAt: new Date() })
        .where(eq(tours.id, t.id));
    // B-06 "Obtain the property rundown": the agent's note on a home seen.
    if (input.note && input.status === 'visited')
      await addProof(
        ctx,
        deal,
        { keys: ['B-06'] },
        { kind: 'note', body: `${home.address}: ${input.note}` },
      );
    if (stop.status !== input.status)
      await historyLine(ctx, deal, 'tour_visited', {
        after: { address: home.address, status: input.status },
      });
    await ctx.emit({
      type: 'realestate.tour.visited',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { tourId: t.id, stopId: stop.id, homeId: home.id, status: input.status, tourStatus },
    });
    return { tourId: t.id, stopId: stop.id, tourStatus };
  },
});

export const tourFeedbackAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.feedback',
  description:
    'Keep what a client thought of a home they saw on a tour (loved it, maybe, not for us), as the agent heard it.',
  risk: 1,
  input: TourFeedbackInput,
  output: TourFeedbackOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // The client's reaction, as heard at the stop with no signal (board 83). The client's own from their portal, given
  // after it, stays (board 79).
  offline: 'anytime',
  emits: ['realestate.tour.feedback_added', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const stop = await loadStop(ctx, input.stopId);
    const t = await loadTour(ctx, stop.tourId);
    const deal = await loadDeal(ctx, t.dealRecordId, { lock: true });
    requireOpen(deal);
    const home = await loadHome(ctx, stop.homeId);
    const clients = await clientsOf(ctx, deal.recordId);
    const name = clients.get(input.personId);
    if (!name)
      throw HfosError.rule(
        'realestate_tour_not_client',
        409,
        `That person isn’t a client on ${deal.name}. Add them as a client on the deal first.`,
      );
    if (stop.status !== 'visited')
      throw HfosError.rule(
        'realestate_tour_not_seen',
        409,
        `Mark ${home.address} seen on the tour first, then add what ${name} thought of it.`,
      );
    if (input.words) refuseFairHousingWords([input.words]);
    const [before] = await ctx.tx
      .select({
        id: tourFeedback.id,
        recordedBy: tourFeedback.recordedBy,
        updatedAt: tourFeedback.updatedAt,
      })
      .from(tourFeedback)
      .where(and(eq(tourFeedback.stopId, stop.id), eq(tourFeedback.personId, input.personId)));
    // What the client said themselves, in their portal after this was noted on a phone, isn't written over.
    if (
      before &&
      before.recordedBy === null &&
      before.updatedAt.getTime() > changeMoment(ctx.meta).getTime()
    )
      throw HfosError.rule(
        'realestate_tour_feedback_theirs',
        409,
        `${name} sent their own feedback on ${home.address} from the portal, ${fmtAt(before.updatedAt.getTime(), await timeZoneOf(ctx))}, after you noted it here, so theirs stays. Add what you heard as a note on the home.`,
      );
    const values = {
      interest: input.interest,
      rating: input.rating ?? null,
      words: input.words ?? null,
      recordedBy: actorUserId(ctx),
      updatedAt: new Date(),
    };
    const [row] = before
      ? await ctx.tx
          .update(tourFeedback)
          .set(values)
          .where(eq(tourFeedback.id, before.id))
          .returning({ id: tourFeedback.id })
      : await ctx.tx
          .insert(tourFeedback)
          .values({
            workspaceId: deal.workspaceId,
            dealRecordId: deal.recordId,
            tourId: t.id,
            stopId: stop.id,
            homeId: home.id,
            personId: input.personId,
            ...values,
          })
          .returning({ id: tourFeedback.id });
    await historyLine(ctx, deal, 'tour_feedback', {
      after: { address: home.address, name, interest: input.interest },
    });
    // B-08 "Collect showing feedback".
    await addProof(
      ctx,
      deal,
      { keys: ['B-08'] },
      { kind: 'note', body: feedbackWords(name, home.address, input) },
    );
    await ctx.emit({
      type: 'realestate.tour.feedback_added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        tourId: t.id,
        stopId: stop.id,
        homeId: home.id,
        personId: input.personId,
        interest: input.interest,
        by: actorKind(ctx),
      },
    });
    return { feedbackId: row!.id, updated: !!before };
  },
});

export const tourFollow = defineAddonCommand(realestateAddon, {
  name: 'realestate.tour.follow',
  description:
    'Worker: a tour’s appointment was moved or canceled on the calendar (by the team or the client); the tour follows.',
  risk: 0,
  input: TourFollowInput,
  output: TourFollowOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.tour.rescheduled', 'realestate.tour.canceled', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const [t] = await ctx.tx
      .select()
      .from(tours)
      .where(
        and(
          eq(tours.appointmentId, input.appointmentId),
          eq(tours.workspaceId, ctx.scope.workspaceId!),
        ),
      )
      .for('update');
    if (!t || t.status !== 'planned') return { tourId: t?.id ?? null, changed: false };
    const deal = await loadDeal(ctx, t.dealRecordId);
    const tz = await timeZoneOf(ctx);
    const by = input.by === 'customer' ? 'the client' : 'the calendar';
    if (input.change === 'cancelled') {
      await ctx.tx
        .update(tours)
        .set({
          status: 'canceled',
          canceledAt: changeMoment(ctx.meta),
          canceledReason: input.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(tours.id, t.id));
      const when = fmtAt(t.startsAt.getTime(), tz);
      await historyLine(ctx, deal, 'tour_canceled', {
        after: { when, by },
        note: input.reason ?? null,
      });
      await withdrawProof(
        ctx,
        deal,
        { appointmentId: input.appointmentId },
        'The tour was canceled.',
      );
      await ctx.emit({
        type: 'realestate.tour.canceled',
        entityType: 'realestate_deal',
        entityId: deal.recordId,
        payload: { tourId: t.id, by: input.by ?? 'calendar' },
        after: { when, reason: input.reason ?? null },
      });
      return { tourId: t.id, changed: true };
    }
    if (!input.startsAt || !input.endsAt) return { tourId: t.id, changed: false };
    const starts = new Date(input.startsAt);
    const ends = new Date(input.endsAt);
    if (starts.getTime() === t.startsAt.getTime() && ends.getTime() === t.endsAt.getTime())
      return { tourId: t.id, changed: false };
    await ctx.tx
      .update(tours)
      .set({ startsAt: starts, endsAt: ends, updatedAt: new Date() })
      .where(eq(tours.id, t.id));
    const from = fmtAt(t.startsAt.getTime(), tz);
    const to = fmtAt(starts.getTime(), tz);
    await historyLine(ctx, deal, 'tour_moved', { before: { when: from }, after: { when: to, by } });
    await ctx.emit({
      type: 'realestate.tour.rescheduled',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { tourId: t.id, by: input.by ?? 'calendar', exception: false },
      before: { when: from },
      after: { when: to },
    });
    return { tourId: t.id, changed: true };
  },
});

// ---------- the query ----------

export const toursList = defineAddonQuery(realestateAddon, {
  name: 'realestate.tours',
  description:
    'A buyer deal’s tours: when, the homes in order, which were seen, what the client thought of each; and whether the buyer agreement lets a tour go ahead today.',
  input: ToursInput,
  output: ToursOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_tours',
    description: 'A buyer deal’s tours, the homes seen and what the client thought of them.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const tz = await timeZoneOf(ctx);
    const facts = await agreementFactsOf(ctx, deal.recordId);
    const list = await ctx.tx
      .select()
      .from(tours)
      .where(
        and(
          eq(tours.dealRecordId, deal.recordId),
          ...(input.includeCanceled ? [] : [inArray(tours.status, ['planned', 'done'])]),
        ),
      )
      .orderBy(desc(tours.startsAt), desc(tours.id));
    const ids = list.map((t) => t.id);
    const stops = ids.length
      ? await ctx.tx
          .select({ s: tourStops, address: homes.address })
          .from(tourStops)
          .innerJoin(homes, eq(homes.id, tourStops.homeId))
          .where(inArray(tourStops.tourId, ids))
          .orderBy(asc(tourStops.position), asc(tourStops.id))
      : [];
    const feedback = ids.length
      ? await ctx.tx
          .select()
          .from(tourFeedback)
          .where(inArray(tourFeedback.tourId, ids))
          .orderBy(asc(tourFeedback.createdAt), asc(tourFeedback.id))
      : [];
    const clients = await clientsOf(ctx, deal.recordId);
    const people = new Map(clients);
    const missing = feedback.map((f) => f.personId).filter((p) => !people.has(p));
    if (missing.length)
      for (const p of await rows<{ id: string; name: string }>(
        ctx.tx,
        sql`select id, btrim(concat_ws(' ', first_name, last_name)) as name from app.people
            where id = any(${`{${[...new Set(missing)].join(',')}}`}::uuid[])`,
      ))
        people.set(p.id, p.name || 'A client');
    const names = await userNames(ctx, [
      ...list.flatMap((t) => [t.agentUserId, t.exceptionBy]),
      ...feedback.map((f) => f.recordedBy),
    ]);
    const named = {
      user: (id: string) => names.get(id) ?? null,
      person: (id: string) => people.get(id) ?? 'A client',
    };
    const stopRows = stops.map(({ s, address }) => ({ ...s, address }));
    return {
      agreement: agreementOut(facts, deal.name, todayIn(tz)),
      tours: list.map((t) => tourOut(t, stopRows, feedback, named)),
      can: { except: scopeCan(ctx.scope, 'realestate.except' as Permission) },
    };
  },
});

/** A client's feedback as B-08's note: "Linh on 418 Maple Ave: Loved it. “The kitchen!”". */
export const feedbackWords = (
  name: string,
  address: string,
  f: { readonly interest: string; readonly words?: string | null | undefined },
): string =>
  `${name} on ${address}: ${interestWords(f.interest)}.${f.words ? ` “${f.words}”` : ''}`;

/** "Loved it", for the Assistant and history. */
export const interestWords = (interest: string): string =>
  TOUR_INTEREST[interest as keyof typeof TOUR_INTEREST] ?? interest;

export const tourCommands = [
  tourPlan,
  tourSetStops,
  tourReschedule,
  tourCancel,
  tourRecordVisit,
  tourFeedbackAdd,
  tourFollow,
] as const;
export const tourQueries = [toursList] as const;
