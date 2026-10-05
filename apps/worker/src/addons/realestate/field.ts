/**
 * A field note's recording in words (round six, step 8; B-07 "notes, check-in, and transcription"). The phone stores
 * the recording as one of the deal's files and adds the note; this reads that file and hands its bytes to the same
 * transcriber calls use (telephony/transcriber.ts), billed the same way, as speech at 1.5× (money/speech-usage.ts).
 *
 * - **Our own audio only.** Deepgram (and the stand-in) read the bytes given to them. Without a Deepgram key the
 *   transcriber is Twilio's, which only reads its own recordings of calls, so a note's words aren't made then; the
 *   note keeps its recording, and the app says to play it.
 * - **Once.** `realestate.field_note.transcribed` settles a note waiting for its words and ignores any other, so a
 *   repeat changes nothing.
 */
import { fieldNoteTranscribed } from '@hfos/core/addons/realestate/ops/field';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { readFileBytes } from '../../files/read';
import { noteSpeech } from '../../money/speech-usage';
import { isPermanentProviderError, type ProviderAccount } from '../../telephony/provider';
import type { AddonEventContext } from '../types';

/** A recording kept by the phone: a few minutes at most, and never more than this. */
const NOTE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Deepgram and the stand-in never read the carrier account (only Twilio's transcriber does, for its own copy of a
 * call), so a note's audio goes with none.
 */
const NO_ACCOUNT: ProviderAccount = {
  id: '',
  sid: '',
  authToken: '',
  messagingServiceSid: null,
  apiKeySid: null,
  apiKeySecret: null,
  twimlAppSid: null,
};

/** A note with a recording was added: its words, now. */
export async function fieldNoteAdded(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const noteId = typeof p['noteId'] === 'string' ? p['noteId'] : null;
  if (!noteId || p['spoken'] !== true) return;
  const [note] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ audio_file_id: string | null; transcript_state: string }>(
      tx,
      sql`select audio_file_id, transcript_state from addon_realestate.field_notes
          where id = ${noteId}::uuid and workspace_id = ${ctx.scope.workspaceId}::uuid`,
    ),
  );
  if (!note || note.transcript_state !== 'waiting') return;
  const settle = (transcript: string | null) =>
    executeCommand(
      ctx.db,
      fieldNoteTranscribed,
      { workspaceId: ctx.scope.workspaceId, noteId, transcript },
      ctx.actor,
      ctx.meta,
    );
  if (!note.audio_file_id || ctx.transcriber.name === 'twilio') {
    await settle(null);
    return;
  }
  const file = await readFileBytes(ctx, ctx.scope, note.audio_file_id, NOTE_MAX_BYTES);
  if (!file.ok) {
    await settle(null);
    return;
  }
  let sentences: readonly { readonly text: string }[];
  try {
    const started = await ctx.transcriber.submit(NO_ACCOUNT, {
      url: null,
      audio: { data: file.bytes, contentType: file.mimeType ?? 'audio/mp4' },
      recordingSid: `field-note-${noteId}`,
      channels: 1,
    });
    // Ours answer in the same call; one that takes the work away isn't used for notes.
    if (started.status !== 'completed') {
      await settle(null);
      return;
    }
    await noteSpeech(ctx, ctx.scope, [
      {
        key: 'speech.recording.minute',
        quantity: started.billedMinutes ?? 0,
        source: 'transcript',
        ref: `field-note:${noteId}`,
      },
    ]);
    sentences = started.sentences;
  } catch (e) {
    // A transcriber that's busy is worth another try; one that refused, or a third failure, leaves the recording.
    if (!isPermanentProviderError(e) && ctx.attempt < 3) throw e;
    ctx.log.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        noteId,
        transcriber: ctx.transcriber.name,
      },
      'a field note’s recording was not put into words',
    );
    await settle(null);
    return;
  }
  const words = sentences
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 20_000);
  await settle(words || null);
}
