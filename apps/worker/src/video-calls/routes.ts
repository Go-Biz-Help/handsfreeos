/**
 * HandsFreeOS video calls' routes on the worker (docs/video-calls.md), which alone holds LiveKit's secret. A ticket is
 * signed only once core's commands say the person may come in, and it lasts minutes.
 *
 * - `POST /v1/video-calls/join` (signed in): someone from the team joins, straight in. Anyone who can't see the
 *   call's appointment is refused, and their page asks to be let in like anyone else.
 * - `POST /v1/video-calls/start` (signed in): Video call on a customer's page or in a conversation, and Switch to
 *   video on a phone call (part 5). It runs `video_call.start` as the person, with the business's own address for
 *   the customer's link, the way every link a customer opens is built here.
 * - `POST /public/join/:token/enter`: a customer on their own Join link presses Join. In once someone from the team
 *   is there; until then their page asks again every few seconds. Taken out by the team, they ask to come back in.
 *   Their own link is a booking's, or the one the team sent for a call that isn't for an appointment (links.ts).
 * - `GET /public/calls/:callId`, `POST /public/calls/:callId/knock` and `POST /public/calls/:callId/knock/:personId`:
 *   anyone else on the call's link (the team's own address) asks to be let in, and their page asks how it stands.
 *   The page keeps a random key and only its hash is stored, so only that page can ask, or come in. What the page
 *   shows is the business's name and look, never the appointment's title: the link may have been passed on.
 * - `POST /webhooks/livekit`: LiveKit's word on who came and went and when a room closed, checked against our key
 *   and stored, then worked through in order (reports.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  callIdOfRoom,
  customerCallLinkOpens,
  executeCommand,
  executeQuery,
  HfosError,
  hostFirstName,
  isPersonIdentity,
  videoCallEnter,
  videoCallJoin,
  videoCallKnock,
  videoCallKnockStatus,
  videoCallLinkOpens,
  videoCallPollAnswer,
  videoCallPollNow,
  videoCallRoom,
  videoCallStart,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, header, parseBody, recordDelivery, type HttpDeps } from '../http/common';
import { publicLookOf } from '../look/public';
import { publicOrigin } from '../hosting/origin';
import { systemActor, type TenantScope } from '../services';
import { resolveCustomerLink } from './links';
import type { VideoCallProvider } from './provider';

/** LiveKit's reports are small; anything bigger isn't one. */
const WEBHOOK_MAX_BYTES = 64 * 1024;

/** The key a waiting page keeps to itself: random, from the page. */
const Key = z.string().regex(/^[0-9A-Za-z_-]{32,128}$/, 'Refresh the page and try again.');
const Name = z.string().trim().min(1, 'Type your name.').max(120);
const Id = z.uuid();

/** The hash a waiting page's key is kept as. */
export const knockKeyHash = (key: string): string => createHash('sha256').update(key).digest('hex');

const meta = (channel: RequestMeta['channel']): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});

const unavailable = () =>
  HfosError.rule(
    'video_calls_unavailable',
    503,
    'HandsFreeOS video calls aren’t ready yet. Try again later, or ask the business for another way to meet.',
  );

const callNotFound = () =>
  HfosError.notFound(
    'This call link doesn’t open a call. Check you have the whole link, or ask whoever sent it.',
  );

const joinNotFound = () =>
  HfosError.notFound(
    'This Join link doesn’t open a call. Check you have the whole link from your text or email.',
  );

function videoOf(deps: HttpDeps): VideoCallProvider {
  if (!deps.videoCalls) throw unavailable();
  return deps.videoCalls;
}

function idOf(raw: string): string {
  const id = Id.safeParse(raw);
  if (!id.success) throw callNotFound();
  return id.data;
}

/** The business a call belongs to, or null for a call that isn't there (or a business being deleted). */
async function callScope(deps: HttpDeps, callId: string): Promise<TenantScope | null> {
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.video_call_lookup(${callId}::uuid)`,
    ),
  );
  return row ? { workspaceId: row.workspace_id, organizationId: row.organization_id } : null;
}

export async function registerVideoCallRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = Math.max(1, Math.floor(deps.booking?.limitFactor ?? 1));
  // A waiting page asks every three seconds; a knock is once, or a few times by someone typing their name again.
  const polling = { max: 40 * factor, timeWindow: '1 minute' };
  const looking = { max: 30 * factor, timeWindow: '1 minute' };
  const knocking = { max: 10 * factor, timeWindow: '1 minute' };

  // ---------- the team ----------

  app.post('/v1/video-calls/join', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const { callId } = parseBody(z.object({ callId: Id }), req.body);
    const video = videoOf(deps);
    const scope = await callScope(deps, callId);
    if (!scope) throw callNotFound();
    const joined = (
      await executeCommand(
        deps.httpDb,
        videoCallJoin,
        { workspaceId: scope.workspaceId, callId },
        actor,
        meta('web'),
      )
    ).output;
    const ticket = await video.ticket({
      room: videoCallRoom(callId),
      identity: joined.personId,
      name: joined.name,
      kind: 'team',
      rights: joined.rights,
    });
    return { workspaceId: scope.workspaceId, ...joined, ticket };
  });

  // Video call on a customer's page or in a conversation, and Switch to video (part 5): the link goes to the
  // customer on the business's own domain once one works, and the screen opens the call with Join, as above.
  app.post('/v1/video-calls/start', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const body = parseBody(
      z
        .object({
          workspaceId: Id,
          personId: Id.optional(),
          conversationId: Id.optional(),
          channel: z.enum(['sms', 'email']).optional(),
          acknowledgeQuietHours: z.boolean().default(false),
        })
        .refine((b) => !!b.personId || !!b.conversationId, {
          error: 'Pick the customer or the conversation.',
        }),
      req.body,
    );
    videoOf(deps);
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ organization_id: string | null }>(
        tx,
        sql`select private.workspace_organization(${body.workspaceId}::uuid) as organization_id`,
      ),
    );
    // A business that isn't there is the command's to refuse, in its own words.
    const origin = row?.organization_id
      ? await asWorker(
          deps.httpDb,
          { workspaceId: body.workspaceId, organizationId: row.organization_id },
          (tx) => publicOrigin(tx, body.workspaceId, deps.bookingLinks.webUrl),
        )
      : deps.bookingLinks.webUrl;
    const { output } = await executeCommand(
      deps.httpDb,
      videoCallStart,
      { ...body, origin },
      actor,
      meta('web'),
    );
    return output;
  });

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    // ---------- a customer on their own Join link ----------

    pub.post<{ Params: { token: string } }>(
      '/public/join/:token/enter',
      { config: { rateLimit: polling } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const body = parseBody(
          z.object({ name: Name, ask: z.boolean().default(false), key: Key.optional() }),
          req.body,
        );
        const link = await resolveCustomerLink(deps.httpDb, deps.bookingLinks, req.params.token);
        if (!link) throw joinNotFound();
        const video = videoOf(deps);
        const { scope } = link;
        const enterAs = async (as: { attendeeId: string } | { callId: string }) => {
          const said = (
            await executeCommand(
              deps.httpDb,
              videoCallEnter,
              {
                workspaceId: scope.workspaceId,
                ...as,
                name: body.name,
                ask: body.ask,
                ...(body.key ? { knockKeyHash: knockKeyHash(body.key) } : {}),
              },
              systemActor(scope),
              meta('booking_page'),
            )
          ).output;
          if (said.status !== 'in' || !said.personId) return { ...said, ticket: null };
          const ticket = await video.ticket({
            room: videoCallRoom(said.callId),
            identity: said.personId,
            name: said.name,
            kind: 'customer',
            rights: said.rights,
          });
          return { ...said, ticket };
        };
        // The link the team sent for a call that isn't for an appointment (part 5).
        if (link.kind === 'call') {
          const [c] = await asWorker(deps.httpDb, scope, (tx) =>
            rows<{ created_at: Date | string; live: boolean }>(
              tx,
              sql`select created_at, state = 'live' as live from app.video_calls
                  where id = ${link.callId}`,
            ),
          );
          if (!c) throw joinNotFound();
          const opens = customerCallLinkOpens(
            { createdAt: new Date(c.created_at).getTime(), live: c.live },
            Date.now(),
          );
          if (opens === 'over')
            throw HfosError.rule(
              'video_call_over',
              409,
              'This call has ended. Get in touch with the business if you’d like another.',
            );
          return enterAs({ callId: link.callId });
        }
        const { attendeeId } = link;
        const [w] = await asWorker(deps.httpDb, scope, (tx) =>
          rows<{ starts_at: Date | string; ends_at: Date | string; live: boolean }>(
            tx,
            sql`select a.starts_at, a.ends_at, coalesce(c.state = 'live', false) as live
                from app.appointment_attendees aa
                join app.appointments a on a.id = aa.appointment_id
                left join app.video_calls c on c.appointment_id = a.id
                where aa.id = ${attendeeId}`,
          ),
        );
        if (!w) throw joinNotFound();
        const opens = videoCallLinkOpens(
          {
            startsAt: new Date(w.starts_at).getTime(),
            endsAt: new Date(w.ends_at).getTime(),
            live: w.live,
          },
          Date.now(),
        );
        if (opens === 'early')
          throw HfosError.rule(
            'video_call_early',
            409,
            'This call opens an hour before it starts. Come back then, with this same link.',
          );
        if (opens === 'over')
          throw HfosError.rule(
            'video_call_over',
            409,
            'This call has ended. Get in touch with the business to book another time.',
          );
        return enterAs({ attendeeId });
      },
    );

    // ---------- anyone else on the call's link ----------

    pub.get<{ Params: { callId: string } }>(
      '/public/calls/:callId',
      { config: { rateLimit: looking } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const callId = idOf(req.params.callId);
        const scope = await callScope(deps, callId);
        if (!scope) throw callNotFound();
        const [c] = await asWorker(deps.httpDb, scope, (tx) =>
          rows<{
            state: 'open' | 'live' | 'ended';
            on: boolean;
            ai_notes: boolean;
            business: string;
            settings: unknown;
            host: string | null;
          }>(
            tx,
            sql`select c.state, w.video_calls as on, c.ai_notes, coalesce(nullif(bs.name, ''), w.name) as business,
                  w.settings, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as host
                from app.video_calls c
                join app.workspaces w on w.id = c.workspace_id
                left join app.booking_sites bs on bs.workspace_id = w.id
                left join app.users u on u.id = c.host_user_id
                where c.id = ${callId}`,
          ),
        );
        if (!c) throw callNotFound();
        return {
          business: c.business,
          look: publicLookOf(c.settings, deps.storageUrl),
          state: c.state,
          host: hostFirstName(c.host),
          // Calls turned off for the business, or not set up here: the page says so instead of a Join button.
          ready: c.on && !!deps.videoCalls,
          // The AI takes notes from the call: the page says so before they ask to join (the owner's 9a).
          aiNotes: c.ai_notes,
        };
      },
    );

    pub.post<{ Params: { callId: string } }>(
      '/public/calls/:callId/knock',
      { config: { rateLimit: knocking } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const callId = idOf(req.params.callId);
        const body = parseBody(z.object({ name: Name, key: Key }), req.body);
        videoOf(deps);
        const scope = await callScope(deps, callId);
        if (!scope) throw callNotFound();
        const knocked = (
          await executeCommand(
            deps.httpDb,
            videoCallKnock,
            {
              workspaceId: scope.workspaceId,
              callId,
              name: body.name,
              knockKeyHash: knockKeyHash(body.key),
            },
            systemActor(scope),
            meta('booking_page'),
          )
        ).output;
        return { status: 'waiting' as const, personId: knocked.personId, host: knocked.host };
      },
    );

    pub.post<{ Params: { callId: string; personId: string } }>(
      '/public/calls/:callId/knock/:personId',
      { config: { rateLimit: polling } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const callId = idOf(req.params.callId);
        const personId = idOf(req.params.personId);
        const body = parseBody(z.object({ key: Key }), req.body);
        const video = videoOf(deps);
        const scope = await callScope(deps, callId);
        if (!scope) throw callNotFound();
        const stands = await executeQuery(
          deps.httpDb,
          videoCallKnockStatus,
          {
            workspaceId: scope.workspaceId,
            callId,
            personId,
            knockKeyHash: knockKeyHash(body.key),
          },
          systemActor(scope),
          meta('booking_page'),
        );
        if (stands.status !== 'in') return { ...stands, ticket: null };
        const ticket = await video.ticket({
          room: videoCallRoom(callId),
          identity: personId,
          name: stands.name,
          kind: 'guest',
          rights: stands.rights,
        });
        return { ...stands, ticket };
      },
    );

    // ---------- a live poll, for a customer in the call on their own link (webinars, part 2) ----------

    /** The call a customer's own link is for, and who they are. */
    const callOfLink = async (token: string) => {
      const link = await resolveCustomerLink(deps.httpDb, deps.bookingLinks, token);
      if (!link) throw joinNotFound();
      const { scope } = link;
      const [c] = await asWorker(deps.httpDb, scope, (tx) =>
        link.kind === 'call'
          ? rows<{ call_id: string; person_id: string | null }>(
              tx,
              sql`select id as call_id, person_id from app.video_calls where id = ${link.callId}`,
            )
          : rows<{ call_id: string; person_id: string | null }>(
              tx,
              sql`select c.id as call_id, aa.person_id
                  from app.appointment_attendees aa
                  join app.video_calls c on c.appointment_id = aa.appointment_id
                  where aa.id = ${link.attendeeId}`,
            ),
      );
      if (!c) throw joinNotFound();
      return { link, scope, callId: c.call_id, personId: c.person_id };
    };

    pub.get<{ Params: { token: string } }>(
      '/public/join/:token/poll',
      { config: { rateLimit: looking } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const { scope, callId, personId } = await callOfLink(req.params.token);
        const now = await executeQuery(
          deps.httpDb,
          videoCallPollNow,
          { workspaceId: scope.workspaceId, callId, personId },
          systemActor(scope),
          meta('booking_page'),
        );
        // A book button goes to the business's own booking page, on its own address.
        if (now.poll?.button?.action === 'book' && now.bookPath) {
          const origin = await asWorker(deps.httpDb, scope, (tx) =>
            publicOrigin(tx, scope.workspaceId, deps.bookingLinks.webUrl),
          );
          return {
            ...now,
            poll: { ...now.poll, button: { ...now.poll.button, url: `${origin}${now.bookPath}` } },
          };
        }
        return now;
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/join/:token/poll',
      { config: { rateLimit: looking } },
      async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const body = parseBody(z.object({ pollId: Id, value: z.unknown() }), req.body);
        const { link, scope, personId } = await callOfLink(req.params.token);
        if (link.kind === 'call' && !personId) throw joinNotFound();
        const { output } = await executeCommand(
          deps.httpDb,
          videoCallPollAnswer,
          {
            workspaceId: scope.workspaceId,
            pollId: body.pollId,
            ...(link.kind === 'booking'
              ? { attendeeId: link.attendeeId }
              : { personId: personId! }),
            value: body.value,
          },
          systemActor(scope),
          meta('booking_page'),
        );
        return output;
      },
    );
  });

  // ---------- LiveKit's webhooks ----------

  await app.register(async (hooks) => {
    // The signature covers the body exactly as sent, so it's kept as text. LiveKit says application/webhook+json.
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser(
      ['application/json', 'application/webhook+json'],
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    hooks.post('/webhooks/livekit', { bodyLimit: WEBHOOK_MAX_BYTES }, async (req, reply) => {
      const body = typeof req.body === 'string' ? req.body : '';
      const report = deps.videoCalls
        ? await deps.videoCalls.readReport(body, header(req, 'authorization'))
        : null;
      if (!report) {
        deps.log.warn('rejected an unsigned or mis-signed LiveKit webhook');
        return reply.code(401).type('text/plain').send('Invalid signature');
      }
      if (report.event === 'other') return reply.code(200).send();
      const callId = callIdOfRoom(report.room);
      // A room that isn't one of our calls, or the AI's listener coming and going: nothing to keep.
      if (!callId || (report.event !== 'finished' && !isPersonIdentity(report.identity)))
        return reply.code(200).send();
      const scope = await callScope(deps, callId);
      if (!scope) return reply.code(200).send();
      await recordDelivery(deps, {
        provider: 'livekit',
        kind: 'video',
        dedupeKey: report.id,
        accountRef: report.room,
        url: `${deps.publicUrl}${req.url}`,
        params: { ...report },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      });
      return reply.code(200).send();
    });
  });
}
