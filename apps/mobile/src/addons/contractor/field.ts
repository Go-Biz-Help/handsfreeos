import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import type { PhoneMaterial, PhoneNote } from '@hfos/core/addons/contractor/views/phone';
import { CONTRACTOR_WORDS as W } from '@hfos/core/addons/contractor/words';
import * as React from 'react';

import { newId } from '@/changes';
import { takePhoto } from '@/changes/photo-device';
import { toast } from '@/components/ui/toast';
import { keepRecording } from '@/lib/voice-note-recorder';

import { addNote, countMaterial, keepJobFile, removeNote } from './actions';
import type { CountAmounts } from './materials';
import type { NoteActions } from './notes';

/**
 * What a job's page and a visit's work order both do in the field: add a note (typed, a photo, a voice note), take
 * one off, and count materials. Each is a change through the queue, said in a toast when it's kept; one that can't
 * be made says why.
 */

/** Runs a change and says what happened: true when it went through, or waits on this phone. */
export async function attempt(run: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await run();
    if (done) toast.show(done);
    return true;
  } catch (e) {
    toast.error(e instanceof Error && e.message ? e.message : P.kept.refused);
    return false;
  }
}

/** A photo taken for the job just now and kept to upload: its file id and its upload, or null when none was taken. */
export async function takeJobPhoto(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly userId: string;
}): Promise<{ readonly fileId: string; readonly upload: string } | null> {
  const fileId = newId();
  const taken = await takePhoto({ userId: input.userId, source: 'camera', fileId });
  if (taken.kind === 'no-camera-permission') {
    toast.error(P.visit.noCamera);
    return null;
  }
  if (taken.kind !== 'kept') return null;
  const upload = await keepJobFile(input.workspaceId, input.jobId, {
    fileId,
    localName: taken.photo.localName,
    sizeBytes: taken.photo.sizeBytes,
  });
  return { fileId, upload };
}

export function useFieldActions(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly jobId: string;
  readonly jobName: string;
  /** The visit the notes are taken at, on its work order. */
  readonly appointmentId?: string;
}): {
  readonly notes: NoteActions;
  readonly count: (material: PhoneMaterial, amounts: CountAmounts) => Promise<boolean>;
} {
  const { workspaceId, userId, jobId, jobName, appointmentId } = input;
  return React.useMemo(() => {
    const note = { workspaceId, jobId, userId, appointmentId };
    return {
      notes: {
        addTyped: (body: string) => attempt(() => addNote({ ...note, body }), W.notes.added),
        addPhoto: () =>
          attempt(async () => {
            const photo = await takeJobPhoto({ workspaceId, jobId, userId });
            if (!photo) return;
            await addNote({ ...note, photoFileIds: [photo.fileId], dependsOn: [photo.upload] });
            toast.show(P.notes.photoKept);
          }),
        addVoice: (recording: { readonly uri: string }) =>
          attempt(async () => {
            const fileId = newId();
            const file = keepRecording({ userId, fileId, uri: recording.uri });
            const upload = await keepJobFile(workspaceId, jobId, {
              fileId,
              localName: file.localName,
              sizeBytes: file.sizeBytes,
              name: `Voice note, ${jobName}.m4a`.slice(0, 200),
              mimeType: 'audio/mp4',
            });
            await addNote({ ...note, audioFileId: fileId, dependsOn: [upload] });
          }, P.notes.heard),
        remove: (n: PhoneNote) => attempt(() => removeNote(workspaceId, n.id), W.notes.removed),
      },
      count: (material: PhoneMaterial, amounts: CountAmounts) =>
        attempt(() => countMaterial({ workspaceId, materialId: material.id, ...amounts })),
    };
  }, [workspaceId, userId, jobId, jobName, appointmentId]);
}
