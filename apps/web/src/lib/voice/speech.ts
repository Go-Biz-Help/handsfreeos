'use client';
/**
 * Talking out loud's connection to the worker (@hfos/core's voice/index.ts has the contract): a recording goes
 * to POST /v1/speech/hear and comes back as words, and words go to POST /v1/speech/say and come back as audio.
 */
import { heardSpeechOf, type HeardSpeech, type PhoneVoice } from '@hfos/core';
import { ApiError } from '../api/errors';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';

const UNREACHABLE = 'Talking out loud isn’t reachable right now. Try again in a minute.';

async function token(): Promise<string> {
  const t = (await supabaseBrowser().auth.getSession()).data.session?.access_token;
  if (!t) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  return t;
}

/** The worker's error body ({ error: { code, message, rule } }) as an ApiError. */
async function refusal(res: Response): Promise<ApiError> {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; rule?: string };
  } | null;
  const err = json?.error;
  return new ApiError(
    res.status,
    err?.code ?? 'internal',
    err?.message ?? 'Something went wrong. Try again.',
    err?.rule,
  );
}

async function post(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, { method: 'POST', ...init, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'unreachable', UNREACHABLE);
  }
  if (!res.ok) throw await refusal(res);
  return res;
}

/** The worker has nobody to listen and speak (no Deepgram key). */
export const speechNotConfigured = (e: unknown): boolean =>
  e instanceof ApiError && (e.rule === 'speech_not_configured' || e.status === 404);

/** The words in one recording. */
export async function hear(
  workspaceId: string,
  recording: Blob,
  signal?: AbortSignal,
): Promise<HeardSpeech> {
  const res = await post(
    `/v1/speech/hear?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': recording.type || 'audio/webm',
      },
      body: recording,
    },
    signal,
  );
  return heardSpeechOf(await res.json().catch(() => null));
}

/** `text` said in `voice` (null: the AI teammate's own), as audio to play. */
export async function say(
  body: {
    readonly workspaceId: string;
    readonly text: string;
    readonly voice: PhoneVoice | null;
    readonly language: string | null;
  },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await post(
    '/v1/speech/say',
    {
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    signal,
  );
  return res.arrayBuffer();
}
