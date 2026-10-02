/**
 * The video link's routes (20261018000300). A customer opens /v/<token> signed out, picks or records a video, and
 * it goes up as it is, straight to Storage, through a link this worker signs for one path at a time. Then the page
 * says it's done, and the video lands in the conversation as their reply (core's video_link.receive_upload).
 *
 * A link can ask for a file instead (20261018000400): a photo or PDF that answers one of the AI teammate's qualifying
 * questions, like their electric bill. The same routes take it; core's commands check the kind and size, and put it
 * on the lead as well as in the conversation.
 *
 * What stops abuse: the token itself (only its hash is kept, and a link is found by nothing else), per-address
 * limits, a honeypot field, a week's life, three videos and ten uploads started at most per link, Storage's own
 * 250 MB limit on the bucket, and checking what Storage says arrived, not what the page says it sent.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  executeCommand,
  FILE_LINK_WORDS,
  HfosError,
  VIDEO_LINK_MAX_STARTS,
  VIDEO_LINK_WORDS,
  videoLinkDay,
  videoLinkReceiveUpload,
  videoLinkStartUpload,
  videoLinkTokenHash,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { systemActor, type TenantScope } from '../services';
import type { HttpDeps } from './common';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

interface LinkRoute extends Record<string, unknown> {
  readonly video_link_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
}

interface LinkState extends Record<string, unknown> {
  readonly business: string;
  readonly timezone: string;
  readonly expires_at: Date | string;
  readonly max_uploads: number;
  readonly uploads_started: number;
  readonly uploads_received: number;
  /** 20261018000400: what it asks for, and for a file the question's words as asked. */
  readonly asks_for: 'video' | 'file';
  readonly ask: string | null;
}

const StartBody = z.object({
  name: z.string().trim().min(1).max(200),
  contentType: z.string().max(120),
  sizeBytes: z.number().int().min(0),
  /** Hidden on the page. Anything in it is a robot. */
  website: z.string().max(200).optional(),
});

const DoneBody = z.object({
  uploadId: z.uuid(),
  objectPath: z.string().min(3).max(500),
  name: z.string().trim().min(1).max(200),
});

const notFound = () => HfosError.rule('link_not_found', 404, VIDEO_LINK_WORDS.notFound);

/** Why the link takes nothing more right now, in the customer's words; null when it takes a video. */
function problemOf(link: LinkState): { rule: string; message: string } | null {
  const expiresAt = new Date(link.expires_at);
  if (expiresAt.getTime() <= Date.now())
    return {
      rule: 'link_expired',
      message: VIDEO_LINK_WORDS.expired(link.business, videoLinkDay(expiresAt, link.timezone)),
    };
  if (link.uploads_received >= link.max_uploads)
    return {
      rule: 'link_full',
      message: (link.asks_for === 'file' ? FILE_LINK_WORDS : VIDEO_LINK_WORDS).full(
        link.business,
        link.max_uploads,
      ),
    };
  if (link.uploads_started >= VIDEO_LINK_MAX_STARTS)
    return { rule: 'too_many_starts', message: VIDEO_LINK_WORDS.tooManyTries(link.business) };
  return null;
}

export async function registerVideoLinkRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  // One setting scales every public page Playwright drives from one address, as the money pages do.
  const factor = Math.max(1, Math.floor(deps.booking?.limitFactor ?? 1));
  const limits = {
    read: { max: 60 * factor, timeWindow: '1 minute' },
    start: { max: 10 * factor, timeWindow: '1 minute' },
    done: { max: 20 * factor, timeWindow: '1 minute' },
  };
  const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'booking_page' });

  /** The link a token opens, and its business. Holds no business until it knows whose it is. */
  async function find(token: string): Promise<{ linkId: string; scope: TenantScope }> {
    if (!TOKEN_RE.test(token)) throw notFound();
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<LinkRoute>(
        tx,
        sql`select * from private.video_link_lookup(${videoLinkTokenHash(token)})`,
      ),
    );
    if (!row) throw notFound();
    return {
      linkId: row.video_link_id,
      scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
    };
  }

  async function stateOf(linkId: string, scope: TenantScope): Promise<LinkState> {
    const [state] = await asWorker(deps.httpDb, scope, (tx) =>
      rows<LinkState>(
        tx,
        sql`select w.name as business, w.timezone, l.expires_at, l.max_uploads, l.uploads_started, l.uploads_received,
              l.asks_for, l.ask
            from app.video_links l join app.workspaces w on w.id = l.workspace_id
            where l.id = ${linkId}`,
      ),
    );
    if (!state) throw notFound();
    return state;
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    /** What the page shows: whose link it is, and whether it takes a video. Changes nothing (link previews open it). */
    pub.get<{ Params: { token: string } }>(
      '/public/video/:token',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const { linkId, scope } = await find(req.params.token);
        const state = await stateOf(linkId, scope);
        return {
          business: state.business,
          // A link that asks for a file shows the question it answers, and takes photos and PDFs.
          asksFor: state.asks_for,
          ask: state.asks_for === 'file' ? state.ask : null,
          expiresAt: new Date(state.expires_at).toISOString(),
          maxUploads: state.max_uploads,
          received: state.uploads_received,
          problem: problemOf(state),
        };
      },
    );

    /** A video (or a file) is about to go up: checked, counted, and handed a signed link to its one path. */
    pub.post<{ Params: { token: string } }>(
      '/public/video/:token/start',
      { config: { rateLimit: limits.start } },
      async (req) => {
        const body = StartBody.parse(req.body);
        if (body.website) throw notFound();
        const { linkId, scope } = await find(req.params.token);
        const { output } = await executeCommand(
          deps.httpDb,
          videoLinkStartUpload,
          {
            workspaceId: scope.workspaceId,
            videoLinkId: linkId,
            name: body.name,
            contentType: body.contentType,
            sizeBytes: body.sizeBytes,
          },
          systemActor(scope),
          meta(),
        );
        const uploadUrl = await deps.store.signedUploadUrl(output.bucket, output.objectPath);
        return { uploadId: output.uploadId, objectPath: output.objectPath, uploadUrl };
      },
    );

    /**
     * The page says it's up. What Storage says arrived is what's filed: its size and type, not the page's. A video
     * (or file) the link can't take after all (full, not a kind it takes, too big) is taken back out of storage.
     */
    pub.post<{ Params: { token: string } }>(
      '/public/video/:token/done',
      { config: { rateLimit: limits.done } },
      async (req) => {
        const body = DoneBody.parse(req.body);
        const { linkId, scope } = await find(req.params.token);
        // Only the folder this upload was given: never a way to ask about another message's files.
        if (!body.objectPath.startsWith(`${scope.workspaceId}/messages/${body.uploadId}/`))
          throw HfosError.rule('wrong_place', 400, VIDEO_LINK_WORDS.notArrived);
        const stored = await deps.store.info('telephony', body.objectPath);
        if (!stored || stored.size === 0)
          throw HfosError.rule('not_arrived', 409, VIDEO_LINK_WORDS.notArrived);
        try {
          const { output } = await executeCommand(
            deps.httpDb,
            videoLinkReceiveUpload,
            {
              workspaceId: scope.workspaceId,
              videoLinkId: linkId,
              uploadId: body.uploadId,
              objectPath: body.objectPath,
              name: body.name,
              contentType: stored.contentType,
              sizeBytes: stored.size,
            },
            systemActor(scope),
            meta(),
          );
          return { sent: true, duplicate: output.duplicate };
        } catch (e) {
          if (e instanceof HfosError && e.status < 500)
            await deps.store
              .remove('telephony', body.objectPath)
              .catch((err: unknown) =>
                deps.log.warn({ err }, 'could not remove a video the link turned away'),
              );
          throw e;
        }
      },
    );
  });
}
