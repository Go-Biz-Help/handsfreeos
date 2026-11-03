/**
 * Joining an online session (funnels). Each attendee's confirmation, reminders and workflow texts carry their own
 * Join link, `/j/<public_ref><code>` on the business's domain (booking/links.ts), instead of the meeting's address.
 * The web's /j/ page posts here from the person's browser; this records that they joined, then answers with the
 * meeting's address for the page to send them on to.
 *
 * - **Only a person counts.** Text apps and mail scanners open links to make previews, which would mark everyone
 *   as joined. They don't run the page's script, so they never post here; known preview and scanner visitors that
 *   do are sent on without being counted.
 * - **From an hour before to the end.** Outside that the page shows the session's time instead.
 * - **A forwarded link** still counts for the person it was made for. That's rare, and harmless here.
 * - **A HandsFreeOS video call** (docs/video-calls.md) isn't sent anywhere: the page is the call. It answers `call`
 *   with the name on the booking and the business's look, and the page's Join goes to video-calls/routes.ts. Joining
 *   is counted when they're really in the call, not here.
 * - **The link the team sent** for a call that isn't for an appointment (part 5) is the call too, on the same page:
 *   open for a day after it was made, and for as long as the call is going (video-calls/links.ts).
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  attendeeSetAttendance,
  bookingLabel,
  customerCallLinkOpens,
  executeCommand,
  hostFirstName,
  HfosError,
  loadCalendar,
  videoCallLinkOpens,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { appointmentAttendees, appointments } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { publicLookOf, type PublicLook } from '../look/public';
import { systemActor, type TenantScope } from '../services';
import { resolveCustomerLink } from '../video-calls/links';
import { header, type HttpDeps } from './common';

/** How early a Join link opens the meeting. */
export const JOIN_OPENS_MS = 60 * 60_000;

/** Visitors that open links to preview or scan them, not people. */
const PREVIEWS =
  /bot\b|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|linkedin|skype|outlook|microsoft office|ms-office|proofpoint|mimecast|barracuda|headless/i;

export function looksLikePreview(userAgent: string | undefined): boolean {
  return !userAgent || PREVIEWS.test(userAgent);
}

const notFound = () =>
  HfosError.notFound(
    'This Join link doesn’t open a session. Check you have the whole link from your text or email.',
  );

/** What the page shows: on its way to the meeting, or why not yet. */
export type JoinAnswer =
  | {
      readonly state: 'open';
      readonly url: string;
      readonly title: string;
      readonly business: string;
    }
  | {
      readonly state: 'early' | 'over' | 'cancelled' | 'no_link';
      readonly title: string;
      readonly business: string;
      /** "Tue, Oct 27 · 7:00 pm", where the calendar is. */
      readonly when: string;
    }
  | {
      /** A HandsFreeOS video call, open now: the page is the call. */
      readonly state: 'call';
      readonly title: string;
      readonly business: string;
      readonly when: string;
      /** The name on their booking, filled in for them. */
      readonly name: string;
      readonly look: PublicLook;
      /** The AI takes notes from the call: the page says so before they join (the owner's 9a). */
      readonly aiNotes: boolean;
      /**
       * A webinar (a session's call): they join watching, muted with their camera off, so the page asks for no
       * microphone or camera, and their name in the room is their first name.
       */
      readonly webinar?: boolean;
    };

const isVideoCall = (location: unknown): boolean => {
  const l = (location ?? {}) as { kind?: unknown; video?: unknown };
  return l.kind === 'virtual' && l.video === 'handsfree';
};

/** The meeting's own address, when it is one a browser should be sent to. */
function meetingAddress(location: unknown): string | null {
  const l = (location ?? {}) as { kind?: unknown; meetingUrl?: unknown };
  if (l.kind !== 'virtual' || typeof l.meetingUrl !== 'string') return null;
  try {
    const u = new URL(l.meetingUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function registerJoinRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = Math.max(1, Math.floor(deps.booking?.limitFactor ?? 1));
  const limit = { max: 30 * factor, timeWindow: '1 minute' };
  const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'booking_page' });

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    pub.post<{ Params: { token: string } }>(
      '/public/join/:token',
      { config: { rateLimit: limit } },
      async (req, reply): Promise<JoinAnswer> => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const link = await resolveCustomerLink(deps.httpDb, deps.bookingLinks, req.params.token);
        if (!link) throw notFound();
        if (link.kind === 'call') return callAnswer(deps, link.scope, link.callId);
        const { scope, attendeeId } = link;
        const seat = await asWorker(deps.httpDb, scope, async (tx) => {
          const [row] = await tx
            .select({ a: appointmentAttendees, p: appointments })
            .from(appointmentAttendees)
            .innerJoin(appointments, eq(appointments.id, appointmentAttendees.appointmentId))
            .where(eq(appointmentAttendees.id, attendeeId));
          if (!row) return null;
          const calendar = await loadCalendar(tx, scope.workspaceId, row.p.calendarId);
          // The name customers know it by: the booking site's, else the business's.
          const [w] = await rows<{ name: string; settings: unknown; video_calls: boolean }>(
            tx,
            sql`select coalesce(nullif(bs.name, ''), w.name) as name, w.settings, w.video_calls
                from app.workspaces w left join app.booking_sites bs on bs.workspace_id = w.id
                where w.id = ${scope.workspaceId}`,
          );
          const [who] = await rows<{
            name: string;
            first: string;
            live: boolean;
            ai: boolean;
            webinar: boolean;
          }>(
            tx,
            sql`select trim(concat_ws(' ', p.first_name, p.last_name)) as name, trim(p.first_name) as first,
                  coalesce((select c.format = 'webinar' from app.video_calls c
                            where c.appointment_id = ${row.p.id} limit 1), ${row.p.kind === 'session'}) as webinar,
                  exists (select 1 from app.video_calls c
                          where c.appointment_id = ${row.p.id} and c.state = 'live') as live,
                  -- A call is made with its AI notes on; one the team turned them off for says so.
                  coalesce((select c.ai_notes from app.video_calls c
                            where c.appointment_id = ${row.p.id} limit 1), true) as ai
                from app.people p where p.id = ${row.a.personId}`,
          );
          return {
            ...row,
            timeZone: calendar.timeZone,
            business: w?.name ?? 'The business',
            look: publicLookOf(w?.settings, deps.storageUrl),
            videoCalls: w?.video_calls === true,
            name: who?.webinar ? who.first || who.name : (who?.name ?? ''),
            live: who?.live === true,
            aiNotes: who?.ai !== false,
            webinar: who?.webinar === true,
          };
        });
        if (!seat) throw notFound();
        const said = {
          title: seat.p.title,
          business: seat.business,
          when: bookingLabel(seat.p.startsAt.getTime(), seat.timeZone),
        };
        if (seat.a.status === 'cancelled' || seat.p.status === 'cancelled')
          return { state: 'cancelled', ...said };
        if (isVideoCall(seat.p.location)) {
          if (!deps.videoCalls || !seat.videoCalls) return { state: 'no_link', ...said };
          const opens = videoCallLinkOpens(
            {
              startsAt: seat.p.startsAt.getTime(),
              endsAt: seat.p.endsAt.getTime(),
              live: seat.live,
            },
            Date.now(),
          );
          if (opens !== 'open') return { state: opens, ...said };
          return {
            state: 'call',
            ...said,
            name: seat.name,
            look: seat.look,
            aiNotes: seat.aiNotes,
            webinar: seat.webinar,
          };
        }
        const url = meetingAddress(seat.p.location);
        if (!url) return { state: 'no_link', ...said };
        const now = Date.now();
        if (now < seat.p.startsAt.getTime() - JOIN_OPENS_MS) return { state: 'early', ...said };
        if (now > seat.p.endsAt.getTime()) return { state: 'over', ...said };
        if (!looksLikePreview(header(req, 'user-agent')))
          await executeCommand(
            deps.httpDb,
            attendeeSetAttendance,
            { workspaceId: scope.workspaceId, attendeeId, attendance: 'joined' },
            systemActor(scope),
            meta(),
          );
        return { state: 'open', url, title: said.title, business: said.business };
      },
    );
  });
}

/** The link the team sent for a call that isn't for an appointment (part 5): the call itself, or why not. */
async function callAnswer(deps: HttpDeps, scope: TenantScope, callId: string): Promise<JoinAnswer> {
  const [c] = await asWorker(deps.httpDb, scope, (tx) =>
    rows<{
      created_at: Date | string;
      live: boolean;
      on: boolean;
      ai_notes: boolean;
      business: string;
      settings: unknown;
      timezone: string | null;
      name: string | null;
      host: string | null;
    }>(
      tx,
      sql`select c.created_at, c.state = 'live' as live, w.video_calls as on, c.ai_notes,
            coalesce(nullif(bs.name, ''), w.name) as business, w.settings, w.timezone,
            trim(concat_ws(' ', p.first_name, p.last_name)) as name,
            coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as host
          from app.video_calls c
          join app.workspaces w on w.id = c.workspace_id
          left join app.booking_sites bs on bs.workspace_id = w.id
          left join app.people p on p.id = c.person_id
          left join app.users u on u.id = c.host_user_id
          where c.id = ${callId} and c.appointment_id is null`,
    ),
  );
  if (!c) throw notFound();
  const madeAt = new Date(c.created_at).getTime();
  const title = `Video call with ${c.business}`;
  if (!deps.videoCalls || !c.on)
    return {
      state: 'no_link',
      title,
      business: c.business,
      when: bookingLabel(madeAt, c.timezone ?? 'America/Chicago'),
    };
  if (customerCallLinkOpens({ createdAt: madeAt, live: c.live }, Date.now()) === 'over')
    return {
      state: 'over',
      title,
      business: c.business,
      when: bookingLabel(madeAt, c.timezone ?? 'America/Chicago'),
    };
  const host = hostFirstName(c.host);
  return {
    state: 'call',
    title,
    business: c.business,
    when: host ? `With ${host}` : 'Join when you’re ready',
    name: c.name ?? '',
    look: publicLookOf(c.settings, deps.storageUrl),
    aiNotes: c.ai_notes,
  };
}
