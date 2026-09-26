import type { Logger } from 'pino';
import { ProviderError, type ProviderAccount, type TranscriptionState } from './provider';
import type {
  TranscribeRequest,
  TranscribeStarted,
  Transcriber,
  TranscriptSentence,
} from './transcriber';

/**
 * Deepgram: the words of a recording we already hold.
 *
 * Pre-recorded audio is one request — hand it a link or the bytes themselves, get the transcript back — so there
 * is nothing to poll and nothing of ours left on their side afterwards. That is why `fetch` and `forget` are the
 * shapes they are here: the seam has to fit Conversational Intelligence, which takes the work and is read back
 * later, and this reads back nothing because it never left anything behind.
 *
 * Nova-3, with utterances so the words come back as turns rather than one block. A bridged call is recorded one
 * side per channel, and `multichannel` keeps them apart; a voicemail is mono and is all the caller.
 */

const BASE = 'https://api.deepgram.com/v1/listen';
/** Longer than a voicemail or a sales call needs, and short enough that a hung request frees the job. */
const TIMEOUT_MS = 120_000;

interface DeepgramUtterance {
  readonly channel?: number;
  readonly transcript?: string;
  readonly start?: number;
}

interface DeepgramReply {
  readonly metadata?: { readonly duration?: number };
  readonly results?: {
    readonly utterances?: readonly DeepgramUtterance[];
    readonly channels?: readonly { readonly alternatives?: readonly { transcript?: string }[] }[];
  };
}

function deepgramError(status: number, body: string): ProviderError {
  // 401/403 is the key, 429 is the rate limit, 5xx is theirs: all worth asking again. A 400 is the request.
  const permanent = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
  const message = body.slice(0, 300) || `Deepgram answered ${status}`;
  return new ProviderError(message, String(status), permanent, status);
}

/**
 * Deepgram's channels are 0-based and the worker's are 1-based: the business's side is 1 and the customer's is 2,
 * which is how `wordsOf` names the speakers. A mono recording is a voicemail, so all of it is the customer.
 */
const channelOf = (raw: number | undefined, channels: 1 | 2): number =>
  channels === 1 ? 2 : (raw ?? 0) + 1;

function sentencesOf(reply: DeepgramReply, channels: 1 | 2): TranscriptSentence[] {
  const utterances = reply.results?.utterances ?? [];
  if (utterances.length)
    return [...utterances]
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
      .map((u) => ({ channel: channelOf(u.channel, channels), text: (u.transcript ?? '').trim() }))
      .filter((s) => s.text);
  // No utterances (a very short clip): fall back to each channel's own transcript, in channel order.
  return (reply.results?.channels ?? [])
    .map((c, i) => ({
      channel: channelOf(i, channels),
      text: (c.alternatives?.[0]?.transcript ?? '').trim(),
    }))
    .filter((s) => s.text);
}

export function createDeepgramTranscriber(deps: {
  readonly apiKey: string;
  readonly log: Logger;
}): Transcriber {
  return {
    name: 'deepgram',

    async submit(
      _account: ProviderAccount,
      request: TranscribeRequest,
    ): Promise<TranscribeStarted> {
      const params = new URLSearchParams({
        model: 'nova-3',
        punctuate: 'true',
        smart_format: 'true',
        utterances: 'true',
      });
      if (request.channels === 2) params.set('multichannel', 'true');

      // A link to our copy where there is one, the carrier's bytes where there is not. Deepgram takes either:
      // JSON with a `url`, or the audio itself under its own content type.
      if (!request.url && !request.audio)
        throw new ProviderError(
          'No recording to transcribe: neither a stored copy nor the audio itself.',
          'no-audio',
          true,
        );
      const contentType = request.url
        ? 'application/json'
        : request.audio!.contentType || 'audio/mpeg';
      const payload: BodyInit = request.url
        ? JSON.stringify({ url: request.url })
        : new Uint8Array(request.audio!.data);

      let res: Response;
      try {
        res = await fetch(`${BASE}?${params.toString()}`, {
          method: 'POST',
          headers: { authorization: `Token ${deps.apiKey}`, 'content-type': contentType },
          body: payload,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // A timeout or a dropped connection is worth asking again, so it is not permanent.
        throw new ProviderError(
          e instanceof Error ? e.message : 'Deepgram could not be reached',
          'unreachable',
          false,
        );
      }
      if (!res.ok) throw deepgramError(res.status, await res.text().catch(() => ''));
      const reply = (await res.json().catch(() => ({}))) as DeepgramReply;
      // Deepgram bills each channel of a recording, so a two-sided call is twice its length.
      const seconds = Number(reply.metadata?.duration);
      return {
        status: 'completed',
        sentences: sentencesOf(reply, request.channels),
        billedMinutes:
          Number.isFinite(seconds) && seconds > 0 ? (seconds * request.channels) / 60 : 0,
      };
    },

    // Nothing is ever left working, so nothing is ever read back. A job that asks anyway has lost its place
    // rather than found an empty transcript, and saying "failed" is the honest answer.
    async fetch(): Promise<TranscriptionState> {
      return { status: 'failed' };
    },

    // Deepgram keeps no copy of a pre-recorded transcript, so there is nothing of ours to take back.
    async forget(): Promise<void> {},
  };
}
