/**
 * Talking out loud on the web and the phone (@hfos/core's voice/index.ts has the contract): the Assistant's voice
 * mode, and the AI teammate's test console on a call.
 *
 * - POST /v1/speech/hear?workspaceId=… takes one recording the app made (its body is the audio) and answers the
 *   words in it.
 * - POST /v1/speech/say takes words and answers a clip to play, in one of the AI teammate's phone voices: the
 *   one asked for, or the teammate's own saved voice, so a test call sounds like a real one.
 *
 * Both need assistant.use or ai_team.manage in the workspace, and both use the same speech services as the live
 * calls (deps.speech): with none (production without a Deepgram key) they answer 503 `speech_not_configured`,
 * and the apps say talking out loud isn't set up. Nothing is kept: the recording and the clip exist only for the
 * request. Each person has a generous allowance, counted in memory per machine like the chat's limits, so a
 * runaway loop can't run up the speech bill: 429 `rate_limited` past it.
 */
import {
  audioTypeOf,
  HfosError,
  loadTeammate,
  SPEECH_CLIP_MAX_BYTES,
  SpeechSayInput,
  type PhoneVoice,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runtimeConfigOf } from '../ai-team/config';
import { KeyedLimiter } from '../chat/limiter';
import type { RateRule } from './booking';
import { authenticate, hasPermission, header, parseBody, type HttpDeps } from './common';

const HearQuery = z.object({ workspaceId: z.uuid() });

export interface SpeechLimits {
  /** Recordings heard, per person. */
  readonly hear: RateRule;
  /** Clips said, per person (an answer is said a few sentences at a time). */
  readonly say: RateRule;
}

const MIN = 60_000;
/** A turn every five seconds and every answer said in full, for ten minutes on end, fits. */
export const SPEECH_LIMITS: SpeechLimits = {
  hear: { max: 120, timeWindow: 10 * MIN },
  say: { max: 600, timeWindow: 10 * MIN },
};

const tooMuch = () =>
  HfosError.rule('rate_limited', 429, 'That’s a lot of talking. Wait a minute and try again.');

/** How long hearing or saying one clip may take before the app is told to try again. */
const CLIP_TIMEOUT_MS = 30_000;

const notConfigured = () =>
  HfosError.rule('speech_not_configured', 503, 'Talking out loud isn’t set up yet.');

/** Voice mode is for the Assistant and for testing the AI teammate: either permission lets someone talk. */
async function requireVoice(deps: HttpDeps, userId: string, workspaceId: string): Promise<void> {
  if (await hasPermission(deps, userId, workspaceId, 'assistant.use')) return;
  if (await hasPermission(deps, userId, workspaceId, 'ai_team.manage')) return;
  throw HfosError.forbidden();
}

/** The AI teammate's saved phone voice, or the default when it has none. */
async function teammateVoice(deps: HttpDeps, workspaceId: string): Promise<PhoneVoice> {
  const [ws] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
    rows<{ organization_id: string }>(
      tx,
      sql`select organization_id from app.workspaces where id = ${workspaceId}`,
    ),
  );
  if (!ws) return 'warm';
  const row = await asWorker(
    deps.httpDb,
    { workspaceId, organizationId: ws.organization_id },
    (tx) => loadTeammate(tx, workspaceId),
  );
  return row ? runtimeConfigOf(row.config).phone.voice : 'warm';
}

export async function registerSpeechRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const limits = { ...SPEECH_LIMITS, ...deps.speechLimits };
  const limiter = new KeyedLimiter();
  const allow = (kind: keyof SpeechLimits, userId: string) => {
    if (!limiter.take([{ key: `${kind}:${userId}`, rule: limits[kind] }]).ok) throw tooMuch();
  };
  await app.register(async (scope) => {
    // The recording is the body, as the app made it; only these routes read audio.
    scope.addContentTypeParser(
      /^audio\//,
      { parseAs: 'buffer', bodyLimit: SPEECH_CLIP_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.post('/v1/speech/hear', { bodyLimit: SPEECH_CLIP_MAX_BYTES }, async (req) => {
      const actor = await authenticate(deps, req);
      const { workspaceId } = parseBody(HearQuery, req.query);
      await requireVoice(deps, actor.userId, workspaceId);
      const speech = deps.speech;
      if (!speech) throw notConfigured();
      allow('hear', actor.userId);
      const raw = header(req, 'content-type');
      // The stand-in takes words as text/plain, which is how tests talk to it; a real listener needs audio.
      const contentType =
        audioTypeOf(raw) ??
        (speech.name === 'fake' && raw?.startsWith('text/plain') ? 'text/plain' : null);
      if (!contentType)
        throw HfosError.validation([{ path: 'body', message: 'Send a recording.' }]);
      const audio =
        typeof req.body === 'string'
          ? Buffer.from(req.body, 'utf8')
          : Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.alloc(0);
      if (!audio.length)
        throw HfosError.validation([{ path: 'body', message: 'Nothing was recorded.' }]);
      try {
        return await speech.transcribe(audio, {
          contentType,
          signal: AbortSignal.timeout(CLIP_TIMEOUT_MS),
        });
      } catch (e) {
        deps.log.warn({ err: e, contentType, bytes: audio.length }, 'couldn’t hear a recording');
        throw HfosError.rule('speech_failed', 502, 'Couldn’t hear that. Try again.');
      }
    });

    scope.post('/v1/speech/say', async (req, reply) => {
      const actor = await authenticate(deps, req);
      const input = parseBody(SpeechSayInput, req.body);
      await requireVoice(deps, actor.userId, input.workspaceId);
      const speech = deps.speech;
      if (!speech) throw notConfigured();
      allow('say', actor.userId);
      const voice = input.voice ?? (await teammateVoice(deps, input.workspaceId));
      try {
        const clip = await speech.voiceClip(input.text, {
          voice,
          language: input.language,
          signal: AbortSignal.timeout(CLIP_TIMEOUT_MS),
        });
        return reply.header('cache-control', 'no-store').type(clip.contentType).send(clip.audio);
      } catch (e) {
        deps.log.warn({ err: e, voice }, 'couldn’t say a clip');
        throw HfosError.rule('speech_failed', 502, 'Couldn’t say that out loud. Try again.');
      }
    });
  });
}
