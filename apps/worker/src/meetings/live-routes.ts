/**
 * The coaching Zoom app's own routes (meetings/zoom-live.ts), apart from the meeting-link app's (./routes.ts):
 *
 * - **`GET /oauth/zoom-live/start`**: Connect Zoom from HandsFreeOS (the Zoom panel, or Settings → My calendar). Off
 *   to Zoom with PKCE; its verifier rides in the sealed state, so nothing waits in the database.
 * - **`GET /oauth/zoom-live/callback`**: back from Zoom. From Connect it carries our state; from Zoom's Marketplace
 *   (someone pressed Add on the app's listing) it carries none, and that's fine: the sign-in only says who the Zoom
 *   user is. Either way it reads Zoom's user once, keeps no token, and sends the browser to the web's
 *   `/zoom/connect` with a sealed, short-lived ticket naming that Zoom user.
 * - **`POST /v1/zoom-live/link`**: from `/zoom/connect`, signed in to HandsFreeOS: the ticket and the business they
 *   picked. Both sign-ins agree, so the worker links them (`live_meeting_account.link`). That's how HandsFreeOS knows
 *   a Zoom user is an active person here.
 * - **`POST /webhooks/zoom-live`**: Zoom's events for this app, signed with its own secret token: the URL check,
 *   `app_deauthorized` (the app was removed in Zoom: its links end everywhere), and a meeting's live stream starting
 *   or stopping (`meeting.rtms_started`, `meeting.rtms_stopped`, ./live.ts).
 */
import { createHmac } from 'node:crypto';
import {
  executeCommand,
  HfosError,
  liveMeetingAccountLink,
  liveMeetingAccountRevoke,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parseBody, type HttpDeps } from '../http/common';
import { deadEnd } from '../http/oauth';
import { pkcePair } from '../mailbox/provider';
import { systemActor, workerMeta } from '../services';
import { onStreamStarted, onStreamStopped } from './live';
import { zoomSigned } from './routes';

const WEBHOOK_MAX_BYTES = 256 * 1024;
/** How long a Connect sign-in, and then the step of picking the business, may take. */
const STATE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 30 * 60_000;

/** Who signed in to Zoom, sealed for the web's `/zoom/connect`. */
interface LinkTicket {
  readonly zoomUserId: string;
  readonly email: string | null;
}

export function sealLinkTicket(
  deps: Pick<HttpDeps, 'sealer'>,
  t: LinkTicket,
  now = Date.now(),
): string {
  return deps.sealer.seal(
    JSON.stringify({ k: 'zoomlink', z: t.zoomUserId, m: t.email, e: now + TICKET_TTL_MS }),
  );
}

function openLinkTicket(deps: Pick<HttpDeps, 'sealer'>, sealed: string): LinkTicket | null {
  try {
    const v = JSON.parse(deps.sealer.open(sealed)) as Record<string, unknown>;
    if (v['k'] !== 'zoomlink' || typeof v['z'] !== 'string' || typeof v['e'] !== 'number')
      return null;
    if (v['e'] < Date.now()) return null;
    return { zoomUserId: v['z'], email: typeof v['m'] === 'string' ? v['m'] : null };
  } catch {
    return null;
  }
}

const LinkBody = z.strictObject({
  workspaceId: z.uuid(),
  ticket: z.string().min(1).max(4000),
});

interface ZoomStream {
  meeting_uuid?: unknown;
  rtms_stream_id?: unknown;
  server_urls?: unknown;
  operator_id?: unknown;
}
interface ZoomEvent {
  event?: string;
  payload?: ZoomStream & { plainToken?: unknown; user_id?: unknown; object?: ZoomStream };
}

export async function registerZoomLiveRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const zoom = () => deps.calendars.zoomLive;
  const callbackUrl = `${deps.publicUrl}/oauth/zoom-live/callback`;
  const notSetUp = (reply: Parameters<typeof deadEnd>[0]) =>
    deadEnd(
      reply,
      503,
      'Zoom isn’t set up yet',
      'HandsFreeOS’s coaching app for Zoom isn’t ready on this server yet. Try again later, or ask Go Biz Help.',
    );

  app.get('/oauth/zoom-live/start', async (_req, reply) => {
    const z = zoom();
    if (!z) return notSetUp(reply);
    const { verifier, challenge } = pkcePair();
    const state = deps.sealer.seal(
      JSON.stringify({ k: 'zoomlive', v: verifier, e: Date.now() + STATE_TTL_MS }),
    );
    return reply
      .header('cache-control', 'no-store')
      .redirect(z.authorizeUrl({ state, codeChallenge: challenge, redirectUri: callbackUrl }));
  });

  app.get('/oauth/zoom-live/callback', async (req, reply) => {
    const z = zoom();
    if (!z) return notSetUp(reply);
    const q = req.query as { code?: string; state?: string; error?: string };
    const again = { href: `${deps.publicUrl}/oauth/zoom-live/start`, label: 'Connect Zoom again' };
    if (q.error || !q.code)
      return deadEnd(
        reply,
        400,
        'Zoom didn’t connect',
        'The Zoom sign-in was cancelled or didn’t finish. Nothing was changed.',
        again,
      );
    // From Connect, our state carries the PKCE verifier; from Zoom's Marketplace there's no state at all.
    let verifier: string | null = null;
    if (q.state) {
      try {
        const v = JSON.parse(deps.sealer.open(q.state)) as Record<string, unknown>;
        if (v['k'] !== 'zoomlive' || typeof v['v'] !== 'string' || Number(v['e']) < Date.now())
          throw new Error('stale');
        verifier = v['v'];
      } catch {
        return deadEnd(
          reply,
          400,
          'That Zoom sign-in has expired',
          'It took longer than ten minutes, or the link was already used. Start again.',
          again,
        );
      }
    }
    let who;
    try {
      who = await z.identify({
        code: String(q.code).slice(0, 2000),
        codeVerifier: verifier,
        redirectUri: callbackUrl,
      });
    } catch (e) {
      deps.log.warn({ err: e }, 'the coaching Zoom app’s sign-in failed');
      return deadEnd(
        reply,
        502,
        'Zoom didn’t connect',
        'Zoom didn’t finish the sign-in. Try again in a minute.',
        again,
      );
    }
    const ticket = sealLinkTicket(deps, { zoomUserId: who.id, email: who.email });
    return reply
      .header('cache-control', 'no-store')
      .redirect(`${deps.webUrl}/zoom/connect?t=${encodeURIComponent(ticket)}`);
  });

  app.post('/v1/zoom-live/link', async (req) => {
    const actor = await authenticate(deps, req);
    const body = parseBody(LinkBody, req.body);
    const ticket = openLinkTicket(deps, body.ticket);
    if (!ticket)
      throw HfosError.rule(
        'zoom_link_expired',
        400,
        'This Zoom sign-in has expired. Connect Zoom again: open HandsFreeOS from Zoom’s Apps, or press Connect Zoom in Settings → My calendar.',
      );
    const [ws] = await asWorker(deps.httpDb, { workspaceId: body.workspaceId }, (tx) =>
      rows<{ organization_id: string | null; member: boolean }>(
        tx,
        sql`select private.workspace_organization(${body.workspaceId}::uuid) as organization_id,
                   coalesce(private.workspace_has_user(${body.workspaceId}::uuid, ${actor.userId}::uuid), false) as member`,
      ),
    );
    if (!ws?.organization_id || !ws.member)
      throw HfosError.notFound(
        'That business isn’t one you work in. Pick one of yours, or ask its owner to invite you.',
      );
    const scope = { workspaceId: body.workspaceId, organizationId: ws.organization_id };
    await executeCommand(
      deps.httpDb,
      liveMeetingAccountLink,
      {
        workspaceId: body.workspaceId,
        userId: actor.userId,
        provider: 'zoom',
        externalUserId: ticket.zoomUserId,
        accountEmail: ticket.email,
      },
      systemActor(scope),
      workerMeta(),
    );
    return { linked: true, accountEmail: ticket.email };
  });

  await app.register(async (hooks) => {
    // The raw body is what Zoom signs: JSON stays the exact string that arrived.
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, b, done) => done(null, b),
    );
    hooks.post('/webhooks/zoom-live', { bodyLimit: WEBHOOK_MAX_BYTES }, async (req, reply) => {
      const secret = zoom()?.webhookSecret ?? null;
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const timestamp = String(req.headers['x-zm-request-timestamp'] ?? '');
      const signature = String(req.headers['x-zm-signature'] ?? '');
      if (!zoomSigned(secret, timestamp, signature, rawBody)) {
        deps.log.warn('rejected an unsigned, stale or mis-signed coaching Zoom webhook');
        return reply.code(401).type('text/plain').send('Invalid signature');
      }
      let body: ZoomEvent;
      try {
        body = JSON.parse(rawBody) as ZoomEvent;
      } catch {
        return reply.code(400).type('text/plain').send('Not JSON');
      }
      const text = (v: unknown, max: number) =>
        typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

      if (body.event === 'endpoint.url_validation') {
        const plainToken = String(body.payload?.plainToken ?? '').slice(0, 200);
        return reply.send({
          plainToken,
          encryptedToken: createHmac('sha256', secret!).update(plainToken).digest('hex'),
        });
      }

      // Removed in Zoom: that Zoom user's links end in every business here.
      if (body.event === 'app_deauthorized') {
        const zoomUser = text(body.payload?.user_id, 200);
        if (zoomUser) {
          const found = await asWorker(deps.httpDb, {}, (tx) =>
            rows<{ account_id: string; workspace_id: string; organization_id: string }>(
              tx,
              sql`select account_id, workspace_id, organization_id
                  from private.live_meeting_accounts_by_external_user('zoom', ${zoomUser})`,
            ),
          );
          for (const a of found)
            await executeCommand(
              deps.httpDb,
              liveMeetingAccountRevoke,
              { workspaceId: a.workspace_id, accountId: a.account_id },
              systemActor({ workspaceId: a.workspace_id, organizationId: a.organization_id }),
              workerMeta(),
            );
          deps.log.info({ links: found.length }, 'the coaching app was removed in Zoom');
        }
        return reply.code(200).send({ ok: true });
      }

      // A meeting's live stream: heard after the answer, so Zoom isn't kept waiting.
      if (body.event === 'meeting.rtms_started' || body.event === 'meeting.rtms_stopped') {
        const p = { ...body.payload, ...body.payload?.object };
        const meetingUuid = text(p.meeting_uuid, 200);
        const streamId = text(p.rtms_stream_id, 200);
        const serverUrl = text(p.server_urls, 2000);
        if (body.event === 'meeting.rtms_stopped') {
          if (streamId) onStreamStopped(streamId);
        } else if (meetingUuid && streamId && serverUrl) {
          const input = { meetingUuid, streamId, serverUrl, operatorId: text(p.operator_id, 200) };
          setImmediate(() => {
            onStreamStarted(deps, input).catch((e: unknown) =>
              deps.log.error({ err: e }, 'could not hear a Zoom meeting'),
            );
          });
        }
      }
      // Everything else Zoom sends is acknowledged, so it doesn't retry.
      return reply.code(200).send({ ok: true });
    });
  });
}
