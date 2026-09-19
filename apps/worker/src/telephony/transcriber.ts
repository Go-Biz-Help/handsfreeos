import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { createDeepgramTranscriber } from './deepgram';
import { createFakeTranscriber } from './fake-transcriber';
import type { ProviderAccount, TelephonyProvider, TranscriptionState } from './provider';
import { createTwilioTranscriber } from './twilio-transcriber';

/**
 * Turning a call recording into words, apart from the carrier that carried the call.
 *
 * It used to be two mechanisms wearing one name. A voicemail went through Twilio's legacy
 * `<Record transcribe="true">`, which skips anything under two seconds, costs $0.05 per 15-second block — about
 * fifteen times the call itself — and whose Recording Transcriptions API Twilio has deprecated. A whole bridged
 * call went through Conversational Intelligence instead. Neither was reachable from the other, and the voicemail
 * path failed silently when it failed at all.
 *
 * Now there is one path and one seam. The audio is already ours: `onRecording` copies every recording into the
 * workspace's private `telephony` bucket before anything else happens and deletes the carrier's copy, so a
 * transcriber only ever needs a signed link to our own object. That is what makes the vendor swappable, and it is
 * why this does not live on `TelephonyProvider` — nothing here is the phone company's business.
 */

/** How the audio was recorded, which decides how its speakers are told apart. */
export interface TranscribeRequest {
  /** A signed link to our copy of the recording. It only has to outlive the request. */
  readonly url: string;
  /**
   * The carrier's own id for the recording. Only the Twilio transcriber needs it, because Conversational
   * Intelligence reads Twilio's copy rather than ours; it is also what deletes that copy once we have the words.
   */
  readonly recordingSid: string;
  /**
   * `2` for a bridged call, which Twilio records one side per channel (`record-from-answer-dual`); `1` for a
   * voicemail, which is the caller alone. Either way the words come back on the channels the rest of the worker
   * already expects: 1 is the business's side, 2 is the customer's.
   */
  readonly channels: 1 | 2;
}

/**
 * What asking for a transcript gives back. Some transcribers answer in the same call (Deepgram reads the audio and
 * returns the words); others take the work and are read back later (Conversational Intelligence). Both shapes are
 * here so the job can settle at once where it can, and poll only where it must.
 */
export type TranscribeStarted =
  | { readonly status: 'completed'; readonly sentences: TranscriptSentence[] }
  | { readonly status: 'working'; readonly jobId: string };

export interface TranscriptSentence {
  /** 1 the business's side, 2 the customer's. */
  readonly channel: number;
  readonly text: string;
}

export interface Transcriber {
  /** What it is, for logs and for the words the app shows when it fails. */
  readonly name: 'deepgram' | 'twilio' | 'fake';
  /**
   * Asks for a recording's words. `account` is the workspace's carrier account, which only the Twilio transcriber
   * needs — a transcriber of our own reads the signed link and nothing else.
   */
  submit(account: ProviderAccount, request: TranscribeRequest): Promise<TranscribeStarted>;
  /** Reads back a job that was still working. */
  fetch(account: ProviderAccount, jobId: string): Promise<TranscriptionState>;
  /**
   * Removes the transcriber's own copy of the words, where it keeps one. A transcriber that keeps nothing does
   * nothing here, and one that has already forgotten is fine.
   */
  forget(account: ProviderAccount, jobId: string): Promise<void>;
}

/** Deepgram in production; Conversational Intelligence without a Deepgram key; the stand-in for tests. */
export function createTranscriber(
  env: WorkerEnv,
  log: Logger,
  telephony: TelephonyProvider,
): Transcriber {
  if (env.transcriber === 'deepgram' && env.deepgramApiKey)
    return createDeepgramTranscriber({ apiKey: env.deepgramApiKey, log });
  if (env.transcriber === 'fake') return createFakeTranscriber({ log });
  return createTwilioTranscriber(telephony);
}
