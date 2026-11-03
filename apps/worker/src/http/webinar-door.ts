/**
 * A webinar's link anyone can use, `/live/<key>` (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, the owner's 5c). The
 * web's /live/ page reads the webinar here and sends its door form here; everything runs as the system actor on the
 * `booking_page` channel, after the booking page's per-address limits, honeypot and bot check.
 *
 * - `GET /public/live/:key`: the business's name and look, the webinar's title and time, and how it stands
 *   (`upcoming`, `open` from an hour before to the end, `full`, `over`, `cancelled`), with the boxes the form shows.
 * - `POST /public/live/:key/register`: saves a seat (core's `webinar.register`). A new customer gets their own Join
 *   link back, so the page goes straight in while it's open. Anyone already on file is sent theirs instead
 *   (video-calls/webinars.ts), so typing someone else's details gets nobody in as them.
 * - **A webinar that asks for payment** isn't taken here: the page points to the booking page, which takes it.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  executeCommand,
  fmtWhen,
  HfosError,
  isWebinarDoorKey,
  loadCalendar,
  videoCallLinkOpens,
  webinarRegister,
  WEBINAR_WORDS,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { passThroughBotCheck } from '../booking/bot-check';
import { depositPlan } from '../booking/deposit';
import { joinUrlFor } from '../booking/links';
import { systemActor, type TenantScope } from '../services';
import { queueJoinLink } from '../video-calls/webinars';
import {
  businessIn,
  limitsFor,
  publicPaths,
  refuseHoneypot,
  splitName,
  usPhone,
  zoneLabel,
} from './booking';
import { parseBody, type HttpDeps } from './common';

const meta = (): RequestMeta => ({
  correlationId: randomUUID(),
  causationId: null,
  channel: 'booking_page',
});

const doorNotFound = () =>
  HfosError.notFound(
    'This webinar link doesn’t open a webinar. Check you have the whole link, or ask whoever shared it.',
  );

const RegisterBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(160),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  smsConsent: z.boolean().default(false),
  offersConsent: z.boolean().default(false),
  callConsent: z.boolean().default(false),
  /** The honeypot: people never see it, so it stays empty. */
  website: z.string().max(500).optional(),
  turnstileToken: z.string().max(2048).optional(),
});

/** How a webinar stands for someone on its link anyone can use. */
export type DoorState = 'upcoming' | 'open' | 'full' | 'over' | 'cancelled';

interface Door {
  readonly scope: TenantScope;
  readonly callId: string;
}

interface Webinar {
  readonly appointmentId: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly state: DoorState;
  readonly on: boolean;
  readonly aiNotes: boolean;
  readonly calendarId: string;
  readonly site: { readonly slug: string; readonly name: string | null } | null;
}

/** The webinar a key opens, or null for a key that isn't one (or a business being deleted). */
async function doorOf(deps: HttpDeps, key: string): Promise<Door | null> {
  if (!isWebinarDoorKey(key)) return null;
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ call_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select * from private.video_call_by_door(${key}::text)`,
    ),
  );
  return row
    ? {
        scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
        callId: row.call_id,
      }
    : null;
}

async function webinarOf(tx: Tx, door: Door, now: number): Promise<Webinar | null> {
  const [w] = await rows<{
    appointment_id: string;
    title: string;
    starts_at: Date | string;
    ends_at: Date | string;
    status: string;
    binned: boolean;
    capacity: number;
    seats_taken: number;
    calendar_id: string;
    live: boolean;
    on: boolean;
    ai_notes: boolean;
    site_slug: string | null;
    site_name: string | null;
    site_enabled: boolean | null;
  }>(
    tx,
    sql`select a.id as appointment_id, a.title, a.starts_at, a.ends_at, a.status, a.bin_item_id is not null as binned,
          a.capacity, a.seats_taken, a.calendar_id, c.state = 'live' as live, w.video_calls as on, c.ai_notes,
          bs.slug as site_slug, bs.name as site_name, bs.enabled as site_enabled
        from app.video_calls c
        join app.appointments a on a.id = c.appointment_id
        join app.workspaces w on w.id = c.workspace_id
        left join app.booking_sites bs on bs.workspace_id = w.id
        where c.id = ${door.callId}`,
  );
  if (!w) return null;
  const startsAt = new Date(w.starts_at);
  const endsAt = new Date(w.ends_at);
  const opens = videoCallLinkOpens(
    { startsAt: startsAt.getTime(), endsAt: endsAt.getTime(), live: w.live },
    now,
  );
  const state: DoorState =
    w.status === 'cancelled' || w.binned
      ? 'cancelled'
      : w.status !== 'scheduled' || opens === 'over'
        ? 'over'
        : w.seats_taken >= w.capacity
          ? 'full'
          : opens === 'open'
            ? 'open'
            : 'upcoming';
  return {
    appointmentId: w.appointment_id,
    title: w.title,
    startsAt,
    endsAt,
    state,
    on: w.on,
    aiNotes: w.ai_notes,
    calendarId: w.calendar_id,
    site: w.site_slug && w.site_enabled ? { slug: w.site_slug, name: w.site_name } : null,
  };
}

export async function registerWebinarDoorRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  const opts = deps.booking ?? {};
  const botCheck = opts.botCheck ?? passThroughBotCheck;
  const limits = limitsFor(opts);

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of tries from here. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });

    pub.get<{ Params: { key: string } }>(
      '/public/live/:key',
      { config: { rateLimit: limits.read } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store');
        const door = await doorOf(deps, req.params.key);
        if (!door) throw doorNotFound();
        return asWorker(deps.httpDb, door.scope, async (tx) => {
          const w = await webinarOf(tx, door, Date.now());
          if (!w) throw doorNotFound();
          const calendar = await loadCalendar(tx, door.scope.workspaceId, w.calendarId);
          const business = await businessIn(
            tx,
            door.scope.workspaceId,
            w.site?.name ?? null,
            deps.storageUrl,
          );
          const plan = await depositPlan(deps, tx, door.scope.workspaceId, calendar.config, {
            serviceId: null,
            calendarName: calendar.name,
          });
          const bookingPath =
            w.site && calendar.config.public && calendar.status === 'active'
              ? `/book/${w.site.slug}/${calendar.slug}`
              : null;
          return {
            business,
            title: w.title,
            startsAt: w.startsAt.toISOString(),
            endsAt: w.endsAt.toISOString(),
            timeZone: calendar.timeZone,
            when: fmtWhen(w.startsAt.getTime(), w.endsAt.getTime(), calendar.timeZone, true),
            zone: zoneLabel(calendar.timeZone),
            state: w.state,
            // Calls turned off for the business, or not set up here: the page says so instead of the form.
            ready: w.on && !!deps.videoCalls && calendar.status === 'active',
            // The AI takes notes: the page says so before they join (the owner's 6).
            aiNotes: w.aiNotes,
            // The booking site's slug, for the texting consent's policy link.
            site: w.site?.slug ?? null,
            // A webinar that asks for payment signs up on the booking page, which takes it.
            paid: !!plan,
            bookingPath,
            botCheck: botCheck.enabled ? { siteKey: botCheck.siteKey } : null,
          };
        });
      },
    );

    pub.post<{ Params: { key: string } }>(
      '/public/live/:key/register',
      { config: { rateLimit: limits.book } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        refuseHoneypot(req.body);
        const body = parseBody(RegisterBody, req.body);
        const phone = usPhone(body.phone);
        const verdict = await botCheck.verify(body.turnstileToken, req.ip);
        if (verdict === 'unavailable')
          throw HfosError.rule(
            'bot_check_unavailable',
            503,
            'We couldn’t check this just now. Try again in a minute.',
          );
        if (verdict !== 'pass')
          throw HfosError.rule(
            'bot_check_failed',
            400,
            'We couldn’t confirm you’re a person. Finish the check on this page, then try again.',
          );
        const door = await doorOf(deps, req.params.key);
        if (!door) throw doorNotFound();
        const { scope } = door;
        const before = await asWorker(deps.httpDb, scope, async (tx) => {
          const w = await webinarOf(tx, door, Date.now());
          if (!w) return null;
          const calendar = await loadCalendar(tx, scope.workspaceId, w.calendarId);
          const plan = await depositPlan(deps, tx, scope.workspaceId, calendar.config, {
            serviceId: null,
            calendarName: calendar.name,
          });
          return { w, paid: !!plan, on: w.on && !!deps.videoCalls };
        });
        if (!before) throw doorNotFound();
        if (!before.on) throw HfosError.rule('webinar_off', 409, WEBINAR_WORDS.doorOff);
        if (before.paid)
          throw HfosError.rule(
            'webinar_paid',
            409,
            'This webinar asks for payment to save a seat. Sign up on the business’s booking page instead.',
          );
        const { output } = await executeCommand(
          deps.httpDb,
          webinarRegister,
          {
            workspaceId: scope.workspaceId,
            callId: door.callId,
            customer: { ...splitName(body.name), phone, email: body.email || null },
            smsConsent: body.smsConsent,
            offersConsent: body.offersConsent,
            callConsent: body.callConsent,
          },
          systemActor(scope),
          meta(),
        ).catch(publicPaths);
        const now = Date.now();
        // Open from an hour before to the end: the page goes straight in.
        const open = before.w.state === 'open';
        // A new customer, made just now from this form: their own Join link, so the page can go straight in.
        if (output.personCreated && !output.duplicate) {
          const joinUrl = await asWorker(deps.httpDb, scope, (tx) =>
            joinUrlFor(tx, deps.bookingLinks, output.attendeeId),
          );
          if (joinUrl) return { status: 'registered' as const, open, joinUrl };
        }
        // Already on file: their own Join link goes to the phone or email the business has. A new seat's
        // confirmation carries it already, when the calendar sends one.
        const calendarConfirms = await asWorker(deps.httpDb, scope, async (tx) => {
          const calendar = await loadCalendar(tx, scope.workspaceId, before.w.calendarId);
          const c = calendar.config.notifications.confirmation;
          return c.text || c.email;
        });
        if (output.duplicate || !calendarConfirms || open)
          await asWorker(deps.httpDb, scope, (tx) =>
            queueJoinLink(tx, scope, output.attendeeId, now),
          );
        return { status: 'sent' as const, open, joinUrl: null };
      },
    );
  });
}
