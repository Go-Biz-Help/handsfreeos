/**
 * Notes from the field (docs/contractor.md, "On the phone"): what a tech types, says or photographs on a job, or on
 * one of its visits. What a note may hold and how it reads in a line are pure, in ../notes.ts.
 *
 * - **Made on the phone with its own id,** so a note taken with no signal is the same note when it arrives, and one
 *   sent twice is added once. Its photos and its recording are the job's own files, added first: the note only
 *   points at them, and they stay in the job's files when the note goes.
 * - **A recording's words follow on their own.** The worker makes them and hands them back
 *   (`contractor.note.transcribed`).
 * - **A finished job still takes notes** (a callback, something the customer said afterwards). An archived one
 *   doesn't.
 * - **Anyone takes off their own note;** someone else's takes “Set up Contractor Operations”.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { idUnavailable } from '../../../crm/client-ids';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { contractorAddon } from '../manifest';
import { NOTE_LIMITS, noteAddedWords, noteLine, type TranscriptState } from '../notes';
import {
  NoteAddInput,
  NoteAddOutput,
  NoteListInput,
  NoteListOutput,
  NoteRefInput,
  NoteRemoveOutput,
  NoteTranscribedInput,
  NoteTranscribedOutput,
} from '../schemas';
import { notes } from '../tables';
import { CONTRACTOR_WORDS as W, REFUSALS } from '../words';
import { inWorkspace, jobLine, loadJob, type Ctx, type Job } from './common';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const pathOf = (io: unknown) => {
  const jobId = (io as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === 'string' ? jobPath(jobId) : 'a/contractor';
};
const mayManage = (ctx: Ctx) => scopeCan(ctx.scope, 'contractor.manage' as Permission);

/** These files as the job holds them: there, uploaded, and not deleted. */
async function jobFiles(
  ctx: Ctx,
  job: Job,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const list = await rows<{ id: string; mime_type: string | null }>(
    ctx.tx,
    sql`select id, mime_type from app.files
        where workspace_id = ${ctx.scope.workspaceId!} and record_type = 'custom_record'
          and record_id = ${job.recordId} and status = 'ready' and deleted_at is null
          and id = any(${`{${wanted.join(',')}}`}::uuid[])`,
  );
  return new Map(list.map((f) => [f.id, (f.mime_type ?? '').toLowerCase()]));
}

/**
 * The visit a note was taken on, when it's one of the job's own. A visit deleted for good since (the note waited on
 * a phone) leaves the note on the job itself; a visit of something else is refused.
 */
async function visitFor(ctx: Ctx, job: Job, appointmentId: string | undefined) {
  if (!appointmentId) return null;
  const [a] = await rows<{ record_id: string | null }>(
    ctx.tx,
    sql`select custom_record_id as record_id from app.appointments
        where id = ${appointmentId} and workspace_id = ${ctx.scope.workspaceId!}`,
  );
  if (!a) return null;
  if (a.record_id !== job.recordId)
    throw HfosError.rule(
      'contractor_note_visit_elsewhere',
      409,
      REFUSALS.noteVisitElsewhere(job.name),
    );
  return appointmentId;
}

export const noteAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.note.add',
  description:
    'Leave a note on a job, or on one of its visits: typed, a recording or photos. A recording’s words follow on their own.',
  risk: 1,
  input: NoteAddInput,
  output: NoteAddOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  offline: 'anytime',
  ai: {
    tool: 'contractor_add_note',
    description:
      'Leave a typed note on a job (by job id; body is what it says), for the crew and the office to read. appointmentId puts it on one of the job’s visits. Photos (photoFileIds) and a recording (audioFileId) must already be among the job’s files.',
    keywords: ['note', 'field note', 'jot down', 'voice note'],
    outcome: (output) => ({ words: W.notes.added, path: pathOf(output) }),
  },
  emits: ['contractor.note.added'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    if (input.id) {
      // Sent again after its answer was lost: the note it made.
      const [had] = await ctx.tx
        .select({ recordId: notes.recordId, appointmentId: notes.appointmentId })
        .from(notes)
        .where(and(eq(notes.id, input.id), eq(notes.workspaceId, ws)));
      if (had) {
        if (had.recordId !== input.jobId) throw idUnavailable();
        return { noteId: input.id, jobId: had.recordId, appointmentId: had.appointmentId };
      }
    }
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const appointmentId = await visitFor(ctx, job, input.appointmentId);
    const photoFileIds = [...new Set(input.photoFileIds)];
    const files = await jobFiles(ctx, job, [
      ...photoFileIds,
      ...(input.audioFileId ? [input.audioFileId] : []),
    ]);
    if (photoFileIds.some((id) => !files.has(id)))
      throw HfosError.rule(
        'contractor_note_photo_not_on_job',
        409,
        REFUSALS.notePhotoNotOnJob(job.name),
      );
    if (photoFileIds.some((id) => !files.get(id)!.startsWith('image/')))
      throw HfosError.rule('contractor_not_a_photo', 400, REFUSALS.noteNotAPhoto);
    if (input.audioFileId) {
      const mime = files.get(input.audioFileId);
      if (mime === undefined)
        throw HfosError.rule(
          'contractor_note_recording_not_on_job',
          409,
          REFUSALS.noteRecordingNotOnJob(job.name),
        );
      // A phone's recording is audio in an MP4 box, which some of them call a video.
      if (!mime.startsWith('audio/') && mime !== 'video/mp4')
        throw HfosError.rule('contractor_not_a_recording', 400, REFUSALS.noteNotARecording);
    }
    const noteId = input.id ?? randomUUID();
    const body = input.body ?? null;
    try {
      await ctx.tx.insert(notes).values({
        id: noteId,
        workspaceId: ws,
        recordId: job.recordId,
        appointmentId,
        body,
        audioFileId: input.audioFileId ?? null,
        transcriptState: input.audioFileId ? 'waiting' : 'none',
        photoFileIds,
        createdBy: userIdOf(ctx.actor),
        notedAt: changeMoment(ctx.meta),
      });
    } catch (e) {
      // An id taken by a note this person can't see, here or in another business: the same refusal whoever holds it.
      if (isUniqueViolation(e, 'notes_pkey') || isUniqueViolation(e, 'notes_workspace_id_id_key'))
        throw idUnavailable();
      throw e;
    }
    const parts = { body, spoken: !!input.audioFileId, photos: photoFileIds.length };
    const eventId = await ctx.emit({
      type: 'contractor.note.added',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { noteId, jobId: job.recordId, appointmentId, spoken: parts.spoken },
      after: { typed: !!body, spoken: parts.spoken, photos: parts.photos },
    });
    await jobLine(ctx, job.recordId, noteAddedWords(parts), {
      eventId,
      // The whole note, when the line had to cut it short.
      body: body && body.length > 200 ? body : null,
    });
    return { noteId, jobId: job.recordId, appointmentId };
  },
});

export const noteRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.note.remove',
  description:
    'Take a note off a job. Its photos and its recording stay in the job’s files. Someone else’s note takes “Set up Contractor Operations”.',
  risk: 2,
  input: NoteRefInput,
  output: NoteRemoveOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_note',
    description:
      'Take a note off a job (by note id, from contractor_list_notes). The note can’t be brought back; its photos and recording stay in the job’s files. People take off their own notes; someone else’s takes “Set up Contractor Operations”. Asks the person first.',
    autonomy: 'confirm',
    what: 'Take a note off the job',
    outcome: (output) => ({ words: W.notes.removed, path: pathOf(output) }),
  },
  emits: ['contractor.note.removed'],
  async handler(ctx, input) {
    const [note] = await ctx.tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.workspaceId, ctx.scope.workspaceId!)))
      .for('update');
    if (!note) throw HfosError.notFound(REFUSALS.noteGone);
    const job = await loadJob(ctx, note.recordId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const me = userIdOf(ctx.actor);
    if ((!me || note.createdBy !== me) && !mayManage(ctx))
      throw HfosError.rule('contractor_note_someone_else', 403, REFUSALS.noteSomeoneElse);
    await ctx.tx.delete(notes).where(eq(notes.id, note.id));
    const eventId = await ctx.emit({
      type: 'contractor.note.removed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { noteId: note.id, jobId: job.recordId, appointmentId: note.appointmentId },
      before: {
        note: noteLine({
          body: note.body,
          spoken: note.transcriptState !== 'none',
          transcript: note.transcript,
          transcriptState: note.transcriptState as TranscriptState,
          photos: note.photoFileIds.length,
        }),
      },
    });
    await jobLine(ctx, job.recordId, 'removed a note', { eventId });
    return { noteId: note.id, jobId: job.recordId, removed: true };
  },
});

export const noteTranscribed = defineAddonCommand(contractorAddon, {
  name: 'contractor.note.transcribed',
  description: 'Worker: a voice note’s words, or that they couldn’t be made.',
  risk: 0,
  input: NoteTranscribedInput,
  output: NoteTranscribedOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.note.transcribed'],
  async handler(ctx, input) {
    const [note] = await ctx.tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.workspaceId, ctx.scope.workspaceId!)))
      .for('update');
    // Removed meanwhile: nothing to keep the words on.
    if (!note) return null;
    if (note.transcriptState !== 'waiting')
      return { noteId: note.id, jobId: note.recordId, changed: false };
    const words = input.transcript?.replace(/\s+/g, ' ').trim() || null;
    const state: TranscriptState = words ? 'done' : 'failed';
    await ctx.tx
      .update(notes)
      .set({ transcript: words, transcriptState: state, updatedAt: new Date() })
      .where(eq(notes.id, note.id));
    await ctx.emit({
      type: 'contractor.note.transcribed',
      entityType: 'custom_record',
      entityId: note.recordId,
      payload: { noteId: note.id, jobId: note.recordId, state },
    });
    return { noteId: note.id, jobId: note.recordId, changed: true };
  },
});

export const noteList = defineAddonQuery(contractorAddon, {
  name: 'contractor.note.list',
  description:
    'A job’s notes from the field, the newest first: what was typed, said (with the recording’s words) or photographed, by whom, when, and on which visit.',
  input: NoteListInput,
  output: NoteListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_notes',
    description:
      'A job’s notes from the field (by job id; appointmentId keeps to one visit’s), the newest first: each with its note id, what was typed, a voice note’s words (or that they’re still on their way), its photos’ file ids, who left it, when, and the visit it was taken on.',
    keywords: ['notes', 'field notes', 'voice notes', 'what did the tech say'],
  },
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const found = await ctx.tx
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.recordId, job.recordId),
          eq(notes.workspaceId, ctx.scope.workspaceId!),
          ...(input.appointmentId ? [eq(notes.appointmentId, input.appointmentId)] : []),
        ),
      )
      .orderBy(desc(notes.notedAt), desc(notes.id))
      .limit(NOTE_LIMITS.list + 1);
    const list = found.slice(0, NOTE_LIMITS.list);
    const fileIds = [
      ...new Set(
        list.flatMap((n) => [...n.photoFileIds, ...(n.audioFileId ? [n.audioFileId] : [])]),
      ),
    ];
    const userIds = [...new Set(list.flatMap((n) => (n.createdBy ? [n.createdBy] : [])))];
    const [files, people] = await Promise.all([
      fileIds.length
        ? rows<{ id: string; name: string }>(
            ctx.tx,
            sql`select id, name from app.files
                where workspace_id = ${ctx.scope.workspaceId!} and deleted_at is null
                  and id = any(${`{${fileIds.join(',')}}`}::uuid[])
                order by created_at, id`,
          )
        : [],
      userIds.length
        ? rows<{ id: string; name: string }>(
            ctx.tx,
            sql`select u.id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
                from app.users u where u.id = any(${`{${userIds.join(',')}}`}::uuid[])`,
          )
        : [],
    ]);
    const here = new Set(files.map((f) => f.id));
    const names = new Map(people.map((p) => [p.id, p.name]));
    return {
      jobId: job.recordId,
      notes: list.map((n) => ({
        id: n.id,
        appointmentId: n.appointmentId,
        body: n.body,
        audio:
          n.transcriptState === 'none'
            ? null
            : {
                fileId: n.audioFileId && here.has(n.audioFileId) ? n.audioFileId : null,
                transcript: n.transcript,
                state: n.transcriptState as TranscriptState,
              },
        // A photo deleted from the job's files since is left out.
        photoFileIds: n.photoFileIds.filter((id) => here.has(id)),
        by:
          n.createdBy && names.has(n.createdBy)
            ? { userId: n.createdBy, name: names.get(n.createdBy)! }
            : null,
        notedAt: n.notedAt.toISOString(),
      })),
      files,
      may: { removeAny: mayManage(ctx) },
      truncated: found.length > NOTE_LIMITS.list,
    };
  },
});
