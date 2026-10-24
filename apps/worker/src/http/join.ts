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
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  attendeeSetAttendance,
  bookingLabel,
  executeCommand,
  HfosError,
  loadCalendar,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { appointmentAttendees, appointments } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { resolveJoinToken } from '../booking/links';
import { systemActor } from '../services';
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
        const found = await resolveJoinToken(deps.httpDb, deps.bookingLinks, req.params.token);
        if (found.status !== 'ok') throw notFound();
        const { scope, attendeeId } = found;
        const seat = await asWorker(deps.httpDb, scope, async (tx) => {
          const [row] = await tx
            .select({ a: appointmentAttendees, p: appointments })
            .from(appointmentAttendees)
            .innerJoin(appointments, eq(appointments.id, appointmentAttendees.appointmentId))
            .where(eq(appointmentAttendees.id, attendeeId));
          if (!row) return null;
          const calendar = await loadCalendar(tx, scope.workspaceId, row.p.calendarId);
          // The name customers know it by: the booking site's, else the business's.
          const [w] = await rows<{ name: string }>(
            tx,
            sql`select coalesce(nullif(bs.name, ''), w.name) as name
                from app.workspaces w left join app.booking_sites bs on bs.workspace_id = w.id
                where w.id = ${scope.workspaceId}`,
          );
          return { ...row, timeZone: calendar.timeZone, business: w?.name ?? 'The business' };
        });
        if (!seat) throw notFound();
        const said = {
          title: seat.p.title,
          business: seat.business,
          when: bookingLabel(seat.p.startsAt.getTime(), seat.timeZone),
        };
        if (seat.a.status === 'cancelled' || seat.p.status === 'cancelled')
          return { state: 'cancelled', ...said };
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
