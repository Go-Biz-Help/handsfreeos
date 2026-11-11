import type { PhaseStatus } from '@hfos/core/addons/contractor/progress';
import { phasePercentFromStatus } from '@hfos/core/addons/contractor/progress';
import type { JobStatus } from '@hfos/core/addons/contractor/progress';

import { change, changes, newId } from '@/changes';

/**
 * Contractor Operations' changes from the phone (docs/contractor.md, "On the phone"), each a command through the
 * queue: a checklist item ticked, what was used counted, a break, a note, how far along the work is. Each writes
 * what the person should see at once into the phone's copy of the add-on's rows (`addon_phone_rows`, whose id is
 * `<source>:<the row's id>`), in the same transaction; those rows leave at the next checkpoint once the change is
 * handled. A note made here takes the phone's id. A job's own status and taking a note off need signal.
 */

const nowIso = () => new Date().toISOString();

/** A new row of the add-on's in the phone's copy, as the server will send it. */
export const INSERT_ROW_SQL = `
  INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
  VALUES (?, ?, 'contractor', ?, ?, ?, ?)`;

// ---------- the checklist ----------

export const ITEM_DONE_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.done_at', ?, '$.done_by', ?, '$.skipped_at', NULL, '$.skipped_by', NULL,
                      '$.skip_reason', NULL)
  WHERE id = ?`;
export const ITEM_PHOTO_SQL = `
  UPDATE addon_phone_rows SET data = json_set(data, '$.file_id', ?) WHERE id = ?`;
export const ITEM_UNDONE_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.done_at', NULL, '$.done_by', NULL, '$.file_id', NULL)
  WHERE id = ?`;

/** A checklist item ticked or unticked; a photo item's photo is one of the job's files, often taken just now. */
export function setItem(input: {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly done: boolean;
  readonly userId: string;
  readonly fileId?: string;
  /** The photo's upload, when it was taken just now. */
  readonly dependsOn?: readonly string[];
}) {
  const { workspaceId, itemId, done, fileId } = input;
  const rowId = `work_order_items:${itemId}`;
  return change(
    'contractor.work_order.item_set',
    { workspaceId, itemId, done, ...(done && fileId ? { fileId } : {}) },
    {
      dependsOn: input.dependsOn,
      optimistic: async (tx) => {
        if (!done) {
          await tx.execute(ITEM_UNDONE_SQL, [rowId]);
          return;
        }
        await tx.execute(ITEM_DONE_SQL, [nowIso(), input.userId, rowId]);
        if (fileId) await tx.execute(ITEM_PHOTO_SQL, [fileId, rowId]);
      },
    },
  );
}

// ---------- materials ----------

/** Adds to one count, never under nothing: SQLite's two-argument max(). */
export const MATERIAL_COUNT_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data,
    '$.used', max(0, coalesce(json_extract(data, '$.used'), 0) + ?),
    '$.wasted', max(0, coalesce(json_extract(data, '$.wasted'), 0) + ?),
    '$.returned', max(0, coalesce(json_extract(data, '$.returned'), 0) + ?))
  WHERE id = ?`;

/** What was used, wasted or sent back just now, added to what's counted already. */
export function countMaterial(input: {
  readonly workspaceId: string;
  readonly materialId: string;
  readonly used?: number;
  readonly wasted?: number;
  readonly returned?: number;
}) {
  const { workspaceId, materialId } = input;
  const amounts = {
    ...(input.used ? { used: input.used } : {}),
    ...(input.wasted ? { wasted: input.wasted } : {}),
    ...(input.returned ? { returned: input.returned } : {}),
  };
  return change(
    'contractor.material.count',
    { workspaceId, materialId, ...amounts },
    {
      optimistic: (tx) =>
        tx.execute(MATERIAL_COUNT_SQL, [
          input.used ?? 0,
          input.wasted ?? 0,
          input.returned ?? 0,
          `materials:${materialId}`,
        ]),
    },
  );
}

// ---------- time ----------

export const STRETCH_END_SQL = `
  UPDATE addon_phone_rows SET data = json_set(data, '$.ended_at', ?) WHERE id = ?`;

/**
 * A break taken, or back to work: the stretch that's running ends now, and the next one starts. Offered only while
 * the phone holds the person's running stretch on the visit (`running`).
 */
export function setBreak(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly appointmentId: string;
  readonly userId: string;
  readonly onBreak: boolean;
  /** The person's running stretch on this visit, as the phone holds it. */
  readonly running: { readonly entryId: string };
}) {
  const { workspaceId, jobId, appointmentId, userId, onBreak } = input;
  const at = nowIso();
  return change(
    'contractor.time.set_break',
    { workspaceId, appointmentId, onBreak },
    {
      optimistic: async (tx) => {
        await tx.execute(STRETCH_END_SQL, [at, `time_entries:${input.running.entryId}`]);
        await tx.execute(INSERT_ROW_SQL, [
          `time_entries:${newId()}`,
          workspaceId,
          'time_entries',
          jobId,
          JSON.stringify({
            appointment_id: appointmentId,
            user_id: userId,
            kind: onBreak ? 'break' : 'work',
            started_at: at,
            ended_at: null,
            source: 'break',
            auto_stopped: false,
            fixed_at: null,
          }),
          at,
        ]);
      },
    },
  );
}

// ---------- notes ----------

/** A note from the field: typed, a recording or photos, on the job and on the visit it was taken at. */
export function addNote(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly userId: string;
  readonly appointmentId?: string | null;
  readonly body?: string;
  readonly audioFileId?: string;
  readonly photoFileIds?: readonly string[];
  /** The uploads of the recording and photos taken just now. */
  readonly dependsOn?: readonly string[];
}) {
  const id = newId();
  const at = nowIso();
  const { workspaceId, jobId } = input;
  const body = input.body?.trim() || undefined;
  const photos = [...(input.photoFileIds ?? [])];
  return change(
    'contractor.note.add',
    {
      workspaceId,
      jobId,
      id,
      ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}),
      ...(body ? { body } : {}),
      ...(input.audioFileId ? { audioFileId: input.audioFileId } : {}),
      ...(photos.length ? { photoFileIds: photos } : {}),
    },
    {
      dependsOn: input.dependsOn,
      optimistic: (tx) =>
        tx.execute(INSERT_ROW_SQL, [
          `notes:${id}`,
          workspaceId,
          'notes',
          jobId,
          JSON.stringify({
            appointment_id: input.appointmentId ?? null,
            body: body ?? null,
            audio_file_id: input.audioFileId ?? null,
            transcript: null,
            transcript_state: input.audioFileId ? 'waiting' : 'none',
            photo_file_ids: photos,
            created_by: input.userId,
            noted_at: at,
          }),
          at,
        ]),
    },
  );
}

/** A note taken off: needs signal (who may is decided on what HandsFreeOS holds now). */
export function removeNote(workspaceId: string, noteId: string) {
  return change('contractor.note.remove', { workspaceId, noteId });
}

/**
 * A file kept on the phone for the job (a photo, or a voice note's recording), on the photo track: it uploads when
 * it can, and a tick or a note that names it waits for it. Returns the upload's change id.
 */
export async function keepJobFile(
  workspaceId: string,
  jobId: string,
  file: {
    readonly fileId: string;
    readonly localName: string;
    readonly sizeBytes: number;
    readonly name?: string;
    readonly mimeType?: 'image/jpeg' | 'audio/mp4';
  },
): Promise<string> {
  const added = await changes.addPhoto(
    { workspaceId, recordType: 'custom_record', recordId: jobId },
    { localName: file.localName, sizeBytes: file.sizeBytes },
    { fileId: file.fileId, name: file.name, mimeType: file.mimeType },
  );
  return added.id;
}

// ---------- how far along ----------

export const JOB_PERCENT_SQL = `
  UPDATE addon_phone_rows SET data = json_set(data, '$.percent_done', ?) WHERE id = ?`;

/** A service call's % done. */
export function setPercent(workspaceId: string, jobId: string, percentDone: number) {
  return change(
    'contractor.job.set_percent',
    { workspaceId, jobId, percentDone },
    { optimistic: (tx) => tx.execute(JOB_PERCENT_SQL, [percentDone, `jobs:${jobId}`]) },
  );
}

export const PHASE_STATUS_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.status', ?, '$.percent_done', ?, '$.done_at', ?)
  WHERE id = ?`;

/** A phase moved along: not started, started or done. Its % follows, as the server sets it. */
export function setPhaseStatus(input: {
  readonly workspaceId: string;
  readonly phaseId: string;
  readonly status: PhaseStatus;
  /** Its % as the phone holds it, which Started keeps. */
  readonly percentDone: number;
}) {
  const { workspaceId, phaseId, status } = input;
  return change(
    'contractor.phase.update',
    { workspaceId, phaseId, status },
    {
      optimistic: (tx) =>
        tx.execute(PHASE_STATUS_SQL, [
          status,
          phasePercentFromStatus(status, input.percentDone),
          status === 'done' ? nowIso() : null,
          `phases:${phaseId}`,
        ]),
    },
  );
}

/** A job's own status: needs signal (Done is checked against every visit's checklist). */
export function setJobStatus(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly status: JobStatus;
  readonly reason?: string;
}) {
  const reason = input.reason?.trim();
  return change('contractor.job.set_status', {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    status: input.status,
    ...(reason ? { reason } : {}),
  });
}
