/**
 * Times to meet, in the chat (docs/outreach.md, decision 149; core's rules in
 * packages/core/src/addons/outreach/meeting-times.ts). When a playbook's link is one of the business's own booking
 * pages, a draft for Send the link, the follow-up after it, Offer another time or a reply reads that calendar's open
 * times (`meetingFor`): the person's own when they're free on it, else anyone's (3a), in their time zone when a "Lives
 * in" shows it, else the calendar's (4a). The drafts offer three of them (1a), and a reply where they picked one and
 * gave an email or a mobile number books it (2a): what's offered and booked is kept with the drafts
 * (`outreach.times.keep`), checked again and booked just before the message goes (./times-check.ts).
 *
 * A booking page that can't take a booking in a chat (one that asks for a deposit, a ZIP code, a required question,
 * or the customer's address) offers no times: its link goes as before.
 */
import {
  bookingPageOf,
  openLines,
  pickTimes,
  sayTime,
  TIMES_LOOK_DAYS,
  TimeBooking,
  zoneFromLines,
  zoneWord,
  type DraftTimes,
  type OpenTime,
  type TimeKind,
} from '@hfos/core/addons/outreach/meeting-times';
import { timesKeep } from '@hfos/core/addons/outreach/ops/meeting-times';
import {
  addDays,
  calendarAvailability,
  defaultLocationKind,
  executeCommand,
  executeQuery,
  loadCalendar,
  localDateOf,
  startOfLocalDay,
  type CalendarConfig,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { AddonScopeContext } from '../types';

/** A playbook's booking page, with its open times, as a draft offers them. */
export interface Meeting {
  readonly calendarId: string;
  /** Whose times they are (3a): the person's own when they're free on it; null for anyone on it. */
  readonly hostUserId: string | null;
  /** Their time zone, the times are said in. */
  readonly zone: string;
  readonly now: number;
  /** Every open time, from now (theirs only, with a host). */
  readonly open: readonly OpenTime[];
  /** The three to offer (`pickTimes`). */
  readonly offer: readonly OpenTime[];
}

type RouteRow = {
  workspace_id: string;
  site_id: string | null;
  site_enabled: boolean | null;
  calendar_id: string | null;
  calendar_status: string | null;
  calendar_public: boolean | null;
};

/**
 * Whether a time can be booked in a chat on this calendar: no deposit or price to pay first, no ZIP code or address to
 * route by, and no question that must be answered.
 */
export function bookableInChat(config: CalendarConfig): boolean {
  return (
    config.payments.mode === 'none' &&
    config.territory.routing !== 'zip' &&
    !config.intake.questions.some((q) => q.required) &&
    defaultLocationKind(config) !== 'customer_address'
  );
}

/**
 * The playbook link's booking page and its open times, when it's one of this business's own, on and taking bookings,
 * that can book a time in a chat; null otherwise (any other link goes as before).
 */
export async function meetingFor(
  ctx: AddonScopeContext,
  input: {
    readonly link: string | null | undefined;
    readonly userId: string;
    /** What's known of where they live: their profile's lines. */
    readonly lines: readonly string[];
    readonly country: string | null;
    readonly now?: number;
  },
): Promise<Meeting | null> {
  const page = bookingPageOf(input.link);
  if (!page) return null;
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [route] = await rows<RouteRow>(
      tx,
      sql`select workspace_id, site_id, site_enabled, calendar_id, calendar_status, calendar_public
          from private.booking_route(${page.site}::text, ${page.calendar}::text)`,
    );
    // Another business's page, or one customers can't book on now.
    if (
      !route?.calendar_id ||
      route.workspace_id !== ws ||
      !route.site_id ||
      !route.site_enabled ||
      !route.calendar_public ||
      route.calendar_status !== 'active'
    )
      return null;
    return loadCalendar(tx, ws, route.calendar_id);
  });
  if (!found || !found.config.public || !bookableInChat(found.config)) return null;
  const now = input.now ?? Date.now();
  const zone = zoneFromLines(input.lines, input.country) ?? found.timeZone;
  const to = startOfLocalDay(addDays(localDateOf(now, zone), TIMES_LOOK_DAYS + 1), zone);
  const out = await executeQuery(
    ctx.db,
    calendarAvailability,
    {
      workspaceId: ws,
      calendarId: found.id,
      from: new Date(now).toISOString(),
      to: new Date(to).toISOString(),
      serviceId: null,
    },
    ctx.actor,
    ctx.meta,
  );
  const all: OpenTime[] = out.slots.map((s) => ({
    at: Date.parse(s.startsAt),
    sessionId: s.sessionId,
    userIds: s.userIds,
  }));
  // The person's own times when they're free on it (3a); anyone's when they aren't on it, or never free.
  const mine = all.filter((t) => t.userIds.includes(input.userId));
  const open = mine.length ? mine : all;
  const offer = pickTimes(open, zone, now);
  if (!offer.length) return null;
  return {
    calendarId: found.id,
    hostUserId: mine.length ? input.userId : null,
    zone,
    now,
    open,
    offer,
  };
}

/** The times a draft offers, in words. */
export const offeredWords = (meeting: Meeting): string[] =>
  meeting.offer.map((t) => sayTime(t.at, meeting.zone, meeting.now));

/** What a draft of this kind is told of the times: the three to offer, and for a reply, what's open and who to book. */
export function draftTimes(
  meeting: Meeting,
  kind: TimeKind,
  contact: { readonly email: string | null; readonly phone: string | null },
): DraftTimes {
  return {
    offer: offeredWords(meeting),
    zone: zoneWord(meeting.zone),
    ...(kind === 'reply'
      ? {
          open: openLines(meeting.open, meeting.zone, meeting.now),
          contact: contact.email ?? contact.phone,
        }
      : {}),
  };
}

/**
 * Whether a draft offers the times: it names a time with the zone, the way the AI is told to say them ("tomorrow at
 * 11 ct", "noon ct"). A reply that only answers a question offers none, and keeps none.
 */
export function offersTimes(draft: string, meeting: Meeting): boolean {
  const zone = zoneWord(meeting.zone).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:\\b\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|\\bnoon)\\s*${zone}\\b`,
    'i',
  ).test(draft);
}

/**
 * Keeps what the drafts offer, and the booking a reply makes, for the message queued from one of them (2a): checked
 * again, and the booking made, before it goes. The offer's id; null when they offer nothing and book nothing.
 */
export async function keepTimes(
  ctx: AddonScopeContext,
  input: {
    readonly userId: string;
    readonly profileId: string;
    readonly meeting: Meeting;
    readonly drafts: readonly string[];
    readonly booking: TimeBooking | null;
  },
): Promise<string | null> {
  const { meeting } = input;
  // A booking's drafts all confirm it; otherwise only the ones that offer the times go with them.
  const drafts = input.booking ? input.drafts : input.drafts.filter((d) => offersTimes(d, meeting));
  if (!drafts.length) return null;
  const { output } = await executeCommand(
    ctx.db,
    timesKeep,
    {
      workspaceId: ctx.scope.workspaceId,
      userId: input.userId,
      profileId: input.profileId,
      calendarId: meeting.calendarId,
      hostUserId: meeting.hostUserId,
      zone: meeting.zone,
      times: input.booking
        ? []
        : meeting.offer.map((t) => ({
            at: new Date(t.at).toISOString(),
            says: sayTime(t.at, meeting.zone, meeting.now),
            sessionId: t.sessionId,
          })),
      booking: input.booking,
      drafts: drafts.slice(0, 5).map((d) => d.slice(0, 2_000)),
    },
    ctx.actor,
    ctx.meta,
  );
  return output.offerId;
}

/** The booking a reply makes (2a): the open time they picked, and their email or number; null without both. */
export function bookingOf(
  meeting: Meeting,
  picked: OpenTime | null,
  name: string,
  contact: { readonly email: string | null; readonly phone: string | null },
): TimeBooking | null {
  if (!picked || (!contact.email && !contact.phone)) return null;
  const read = TimeBooking.safeParse({
    at: new Date(picked.at).toISOString(),
    says: sayTime(picked.at, meeting.zone, meeting.now),
    sessionId: picked.sessionId,
    name: name.slice(0, 160),
    email: contact.email,
    phone: contact.email ? null : contact.phone,
  });
  return read.success ? read.data : null;
}
