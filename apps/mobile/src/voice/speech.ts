import { heardSpeechOf, type HeardSpeech, type PhoneVoice } from '@hfos/core';
import { File, Paths, UploadType } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';

import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { isTestOffline, networkSnapshot } from '@/lib/network';

/**
 * Talking out loud's connection to the worker, exactly as the web's (apps/web/src/lib/voice/speech.ts): a recording
 * goes to POST /v1/speech/hear and comes back as words, and words go to POST /v1/speech/say and come back as audio,
 * kept in the cache folder just long enough to play. Only the worker listens and speaks, so it needs signal, and
 * with none the screen says so: nothing is queued.
 */

export type SpeechFailure =
  | 'no_signal'
  | 'not_configured'
  | 'unauthenticated'
  /** The business's balance has run out: the AI, its voice included, waits for a top-up. */
  | 'no_balance'
  | 'failed';

export class SpeechError extends Error {
  constructor(
    message: string,
    readonly failure: SpeechFailure,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}

const NO_SIGNAL = 'Talking out loud needs signal.';
const NOT_SET_UP = 'Talking out loud isn’t set up yet.';

/** The worker's refusal body ({ error: { code, message, rule } }) as a SpeechError. */
function refusal(status: number, body: string): SpeechError {
  let err: { message?: string; rule?: string } | undefined;
  try {
    err = (JSON.parse(body) as { error?: { message?: string; rule?: string } }).error;
  } catch {
    err = undefined;
  }
  const failure: SpeechFailure =
    err?.rule === 'speech_not_configured' || status === 404
      ? 'not_configured'
      : status === 401 || status === 403
        ? 'unauthenticated'
        : status === 402
          ? 'no_balance'
          : 'failed';
  return new SpeechError(
    failure === 'not_configured' ? NOT_SET_UP : (err?.message ?? 'Couldn’t hear that. Try again.'),
    failure,
    status,
  );
}

async function ready(): Promise<string> {
  if (isTestOffline() || !networkSnapshot().online) throw new SpeechError(NO_SIGNAL, 'no_signal');
  if (!config.workerUrl) throw new SpeechError(NOT_SET_UP, 'not_configured');
  const token = await session.accessToken();
  if (!token) throw new SpeechError('Sign in to continue.', 'unauthenticated', 401);
  return token;
}

/** The words in one recording (an M4A the phone made). */
export async function hear(workspaceId: string, recordingUri: string): Promise<HeardSpeech> {
  const token = await ready();
  let result: { status: number; body: string };
  try {
    result = await new File(recordingUri).upload(
      `${config.workerUrl}/v1/speech/hear?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        httpMethod: 'POST',
        uploadType: UploadType.BINARY_CONTENT,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mp4' },
        mimeType: 'audio/mp4',
      },
    );
  } catch {
    throw new SpeechError(NO_SIGNAL, 'no_signal');
  }
  if (result.status >= 400) throw refusal(result.status, result.body);
  try {
    return heardSpeechOf(JSON.parse(result.body));
  } catch {
    return heardSpeechOf(null);
  }
}

let clips = 0;

/** `text` said in `voice` (null: the AI teammate's own), as a file in the cache folder to play and then delete. */
export async function say(
  body: {
    readonly workspaceId: string;
    readonly text: string;
    readonly voice: PhoneVoice | null;
    readonly language: string | null;
  },
  signal?: AbortSignal,
): Promise<string> {
  const token = await ready();
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(`${config.workerUrl}/v1/speech/say`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new SpeechError(NO_SIGNAL, 'no_signal');
  }
  if (!res.ok) throw refusal(res.status, await res.text().catch(() => ''));
  const wav = (res.headers.get('content-type') ?? '').includes('wav');
  const file = new File(Paths.cache, `hfos-speech-${Date.now()}-${clips++}.${wav ? 'wav' : 'mp3'}`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await res.arrayBuffer()));
  return file.uri;
}

/** Deletes a clip once it has played. */
export function forget(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The system empties the cache folder in time anyway.
  }
}
