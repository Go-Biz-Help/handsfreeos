import type { ProviderAccount, TelephonyProvider, TranscriptionState } from './provider';
import type { TranscribeRequest, TranscribeStarted, Transcriber } from './transcriber';

/**
 * Twilio Conversational Intelligence, kept as the fallback for an account with no Deepgram key.
 *
 * It stays on `TelephonyProvider` rather than moving in here, because it genuinely is a carrier feature: it reads
 * Twilio's own copy of the recording, under the workspace's subaccount, and is billed on the same invoice. This
 * only puts it behind the seam, so the jobs talk to one thing whichever transcriber is in use. It is also why
 * `request.url` goes unused here — the signed link to our copy is no good to it.
 *
 * At roughly eight times Deepgram's price it is the fallback and not the default. It is also the one that takes
 * the work and is read back later, which is the shape `TranscribeStarted` exists for.
 */
export function createTwilioTranscriber(telephony: TelephonyProvider): Transcriber {
  return {
    name: 'twilio',

    async submit(account: ProviderAccount, request: TranscribeRequest): Promise<TranscribeStarted> {
      const { transcriptionSid } = await telephony.transcribeRecording(
        account,
        request.recordingSid,
      );
      return { status: 'working', jobId: transcriptionSid };
    },

    fetch(account: ProviderAccount, jobId: string): Promise<TranscriptionState> {
      return telephony.fetchTranscription(account, jobId);
    },

    forget(account: ProviderAccount, jobId: string): Promise<void> {
      return telephony.deleteTranscription(account, jobId);
    },
  };
}
