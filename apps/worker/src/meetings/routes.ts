/**
 * Zoom's webhook (`POST /webhooks/zoom`, HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §8). Zoom signs every
 * request with the app's secret token: `x-zm-signature` is `v0=` and the HMAC-SHA256 of
 * `v0:<x-zm-request-timestamp>:<the raw body>`. It also checks the URL when the subscription is saved
 * (`endpoint.url_validation`). Someone removing the app in Zoom (`app_deauthorized`) disconnects and erases their
 * Zoom connections here. A transcript that's ready (`recording.transcript_completed`) is matched to its
 * appointment by the meeting's id and handed to `appointment.transcript_fetch`; nothing is downloaded here. A
 * meeting's live stream starting or stopping (`meeting.rtms_started`, `meeting.rtms_stopped`) goes to
 * meetings/live.ts, for the add-ons that hear meetings as they happen.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { executeCommand, meetingConnectionRevoke } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import type { HttpDeps } from '../http/common';
import { systemActor, workerMeta } from '../services';
import { onStreamStarted, onStreamStopped } from './live';
import { queueTranscriptFetch } from './transcripts';

const WEBHOOK_MAX_BYTES = 256 * 1024;
/** A signed request older than this is refused, so a captured one can't be played again later. */
const MAX_AGE_MS = 5 * 60_000;

export const zoomSignature = (secret: string, timestamp: string, rawBody: string): string =>
  `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')}`;

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A meeting's live stream (`meeting.rtms_started` / `_stopped`): Zoom puts these on the payload, or its object. */
interface ZoomStream {
  meeting_uuid?: string;
  rtms_stream_id?: string;
  server_urls?: string;
  operator_id?: string;
}

interface ZoomEvent {
  event?: string;
  payload?: ZoomStream & {
    plainToken?: string;
    /** app_deauthorized: the Zoom user who removed the app. */
    user_id?: string;
    object?: ZoomStream & {
      id?: number | string;
      recording_files?: {
        id?: string;
        file_type?: string;
        download_url?: string;
        status?: string;
      }[];
    };
  };
}

export async function registerZoomRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (hooks) => {
    // The raw body is what Zoom signs: JSON stays the exact string that arrived.
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    hooks.post('/webhooks/zoom', { bodyLimit: WEBHOOK_MAX_BYTES }, async (req, reply) => {
      const secret = deps.calendars.zoomWebhookSecret;
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const timestamp = String(req.headers['x-zm-request-timestamp'] ?? '');
      const signature = String(req.headers['x-zm-signature'] ?? '');
      const fresh = Math.abs(Date.now() - Number(timestamp) * 1000) <= MAX_AGE_MS;
      if (!secret || !fresh || !sameText(signature, zoomSignature(secret, timestamp, rawBody))) {
        deps.log.warn('rejected an unsigned, stale or mis-signed Zoom webhook');
        return reply.code(401).type('text/plain').send('Invalid signature');
      }
      let body: ZoomEvent;
      try {
        body = JSON.parse(rawBody) as ZoomEvent;
      } catch {
        return reply.code(400).type('text/plain').send('Not JSON');
      }

      // Saving the subscription: Zoom checks we hold the secret.
      if (body.event === 'endpoint.url_validation') {
        const plainToken = String(body.payload?.plainToken ?? '').slice(0, 200);
        return reply.send({
          plainToken,
          encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex'),
        });
      }

      // Removed in Zoom: that person's Zoom is disconnected in every business here, and what was kept is erased.
      if (body.event === 'app_deauthorized') {
        const zoomUser = String(body.payload?.user_id ?? '').slice(0, 200);
        if (zoomUser) {
          const found = await asWorker(deps.httpDb, {}, (tx) =>
            rows<{ connection_id: string; workspace_id: string; organization_id: string }>(
              tx,
              sql`select connection_id, workspace_id, organization_id
                  from private.meeting_connections_by_external_user('zoom', ${zoomUser})`,
            ),
          );
          for (const c of found) {
            const scope = { workspaceId: c.workspace_id, organizationId: c.organization_id };
            await executeCommand(
              deps.httpDb,
              meetingConnectionRevoke,
              { workspaceId: c.workspace_id, connectionId: c.connection_id },
              systemActor(scope),
              workerMeta(),
            );
          }
          deps.log.info({ connections: found.length }, 'the HandsFreeOS app was removed in Zoom');
        }
        return reply.code(200).send({ ok: true });
      }

      // Someone opened HandsFreeOS in a meeting and Zoom started its stream: the add-ons that listen hear it
      // (meetings/live.ts). Answered at once; the sockets open after.
      if (body.event === 'meeting.rtms_started' || body.event === 'meeting.rtms_stopped') {
        const p = { ...body.payload, ...body.payload?.object };
        const text = (v: unknown, max: number) =>
          typeof v === 'string' && v.length <= max ? v : null;
        const meetingUuid = text(p.meeting_uuid, 200);
        const streamId = text(p.rtms_stream_id, 200);
        if (body.event === 'meeting.rtms_stopped') {
          if (streamId) onStreamStopped(streamId);
        } else if (meetingUuid && streamId && typeof p.server_urls === 'string') {
          const input = {
            meetingUuid,
            streamId,
            serverUrl: p.server_urls,
            operatorId: text(p.operator_id, 200),
          };
          setImmediate(() => {
            onStreamStarted(deps, input).catch((e: unknown) =>
              deps.log.error({ err: e }, 'could not hear a Zoom meeting'),
            );
          });
        }
        return reply.code(200).send({ ok: true });
      }

      if (body.event === 'recording.transcript_completed') {
        const meetingId = String(body.payload?.object?.id ?? '').slice(0, 100);
        const files = (body.payload?.object?.recording_files ?? [])
          .filter((f) => f.file_type === 'TRANSCRIPT' && f.id && f.download_url)
          .slice(0, 5)
          .map((f) => ({
            id: String(f.id).slice(0, 200),
            url: String(f.download_url).slice(0, 2000),
          }));
        if (meetingId && files.length) {
          const [found] = await asWorker(deps.httpDb, {}, (tx) =>
            rows<{ appointment_id: string; workspace_id: string; organization_id: string }>(
              tx,
              sql`select appointment_id, workspace_id, organization_id
                  from private.appointment_by_meeting_id(${meetingId})`,
            ),
          );
          // A meeting HandsFreeOS didn't make (or whose appointment was deleted) is none of ours.
          if (found) {
            const scope = {
              workspaceId: found.workspace_id,
              organizationId: found.organization_id,
            };
            await asWorker(deps.httpDb, scope, (tx) =>
              queueTranscriptFetch(tx, scope, found.appointment_id, files),
            );
          }
        }
      }
      // Everything else Zoom sends is acknowledged, so it doesn't retry.
      return reply.code(200).send({ ok: true });
    });
  });
}
