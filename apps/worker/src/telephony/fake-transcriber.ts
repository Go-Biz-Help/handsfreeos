import type { Logger } from 'pino';
import { FAKE_TRANSCRIPT } from './fake';
import { ProviderError, type ProviderAccount, type TranscriptionState } from './provider';
import type { TranscribeRequest, TranscribeStarted, Transcriber } from './transcriber';

/**
 * The stand-in transcriber, for development and the tests. It answers in the same call the way Deepgram does, so
 * the flows exercise the path that production takes.
 *
 * It plays the awkward cases off the recording's id, as the fake carrier does: `refused` is a transcriber that
 * will not take the work at all, and `silent` is a recording with nothing in it — the two ways the words never
 * arrive, and the two the app has to say something sensible about.
 */
export interface FakeTranscriber extends Transcriber {
  /** The recordings it was asked about, in order, so a test can say the words were actually wanted. */
  readonly asked: readonly string[];
}

export function createFakeTranscriber(deps: { readonly log: Logger }): FakeTranscriber {
  const asked: string[] = [];
  return {
    name: 'fake',
    asked,

    async submit(
      _account: ProviderAccount,
      request: TranscribeRequest,
    ): Promise<TranscribeStarted> {
      asked.push(request.recordingSid);
      deps.log.debug(
        { recordingSid: request.recordingSid, channels: request.channels },
        'fake transcriber asked for a recording’s words',
      );
      if (/refused/i.test(request.recordingSid))
        throw new ProviderError('The transcriber refused this recording.', '403', false, 403);
      // Billed like Deepgram, per channel: a stand-in half a minute a side.
      const billedMinutes = request.channels * 0.5;
      if (/silent/i.test(request.recordingSid))
        return { status: 'completed', sentences: [], billedMinutes };
      // A voicemail is the caller alone, so all of it lands on the customer's channel.
      const sentences =
        request.channels === 1
          ? [{ channel: 2, text: 'Hi, it’s Mike. Give me a call back when you can.' }]
          : FAKE_TRANSCRIPT.map((s) => ({ channel: s.channel, text: s.text }));
      return { status: 'completed', sentences, billedMinutes };
    },

    // Nothing is ever left working, so nothing is ever read back — the same as Deepgram.
    async fetch(): Promise<TranscriptionState> {
      return { status: 'failed' };
    },

    async forget(): Promise<void> {},
  };
}
