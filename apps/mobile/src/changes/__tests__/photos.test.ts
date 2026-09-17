import { Changes } from '../controller';
import { PIECE_BYTES, UPLOAD_ROUNDS } from '../photos';

import { DALE, LONE_STAR, MARIA, phone, refusal, type Phone } from './harness';

/**
 * Photos on their own track: begin with the phone's file id, upload, confirm; a big one in pieces that carries on where
 * it stopped, even after the app was closed; a confirmed photo releasing the note waiting for it; and what happens when
 * the API says the file never arrived, or refuses the photo outright.
 */

const MB = 1_000_000;
const FILE_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';

async function addPhoto(
  p: Phone,
  sizeBytes: number,
  options: { dependsOn?: string[]; fileId?: string } = {},
) {
  const fileId = options.fileId ?? FILE_ID;
  p.storage.keep(`${fileId}.jpg`, sizeBytes);
  return p.changes.addPhoto(
    { workspaceId: LONE_STAR, recordType: 'person', recordId: MARIA },
    { localName: `${fileId}.jpg`, sizeBytes },
    { fileId, dependsOn: options.dependsOn, name: 'Photo.jpg' },
  );
}

const photoRow = (p: Phone, id: string) =>
  p.db.rows<Record<string, unknown>>('SELECT * FROM photo_uploads WHERE id = ?', [id])[0]!;

describe('a photo', () => {
  it('taken offline waits on its own track, then uploads, confirms and releases the note waiting for it', async () => {
    const p = phone({ online: false });
    const photo = await addPhoto(p, 2_400_000);
    const note = await p.changes.change(
      'activity.log',
      { workspaceId: LONE_STAR, personId: MARIA, kind: 'note', body: 'Photo of the old unit' },
      { dependsOn: [photo.id] },
    );
    await p.settle();
    // Nothing for the photo in PowerSync's upload queue: only the note is there.
    expect(p.db.queue()).toEqual([{ table: 'commands', id: note.id, op: 'PUT' }]);
    expect(p.row(photo.id)).toMatchObject({
      state: 'waiting',
      track: 'photo',
      name: 'file.begin_upload',
    });
    expect(photoRow(p, photo.id)).toMatchObject({
      step: 'begin',
      size_bytes: 2_400_000,
      bytes_sent: 0,
    });
    expect(p.changes.getSnapshot().waiting).toBe(2);

    // Signal, but the first upload doesn't get through: the note is reached and held for the photo.
    p.storage.failNext = ['whole'];
    p.setOnline(true);
    await p.settle();
    await p.sync();
    expect(p.row(note.id)).toMatchObject({
      state: 'held',
      reason: 'Held until the photo is uploaded, then it goes.',
    });
    expect(photoRow(p, photo.id)).toMatchObject({ step: 'upload', tries: 1 });
    // A few seconds later the photo uploads on its own track and is confirmed.
    await p.advance(5_000);
    expect(p.api.ran()).toEqual(['file.begin_upload', 'file.confirm']);
    expect(JSON.parse(p.api.sent('file.begin_upload')[0]!.input)).toMatchObject({
      id: FILE_ID,
      recordType: 'person',
      recordId: MARIA,
      mimeType: 'image/jpeg',
      sizeBytes: 2_400_000,
    });
    const whole = `whole http://supabase.test/storage/v1/object/attachments/${LONE_STAR}/person/${MARIA}/${FILE_ID}/Photo.jpg`;
    expect(p.storage.requests).toEqual([whole, whole]);
    expect(p.row(photo.id).state).toBe('sent');
    // The photo's file is gone from the phone once confirmed, and the note went after it.
    expect(p.storage.exists(`${FILE_ID}.jpg`)).toBe(false);
    await p.sync();
    expect(p.api.ran()).toEqual(['file.begin_upload', 'file.confirm', 'activity.log']);
    expect(p.changes.getSnapshot().waiting).toBe(0);
  });

  it('over 6 MB uploads in pieces and carries on from where it stopped, after the app was closed', async () => {
    const p = phone();
    p.storage.piecesBeforeCut = 1;
    const photo = await addPhoto(p, 13 * MB);
    await p.settle();
    expect(photoRow(p, photo.id)).toMatchObject({
      step: 'upload',
      bytes_sent: PIECE_BYTES,
      tries: 1,
    });
    expect(p.row(photo.id)).toMatchObject({
      state: 'waiting',
      reason: 'No signal for the upload. It carries on by itself.',
    });
    expect(p.storage.requests).toEqual(['create', 'piece 0', `piece ${PIECE_BYTES}`]);

    // The app is closed; a new start of it opens the same copy and carries on from Storage's offset.
    await p.changes.closing(p.db, DALE);
    const again = new Changes({
      ...(p.changes as unknown as { deps: ConstructorParameters<typeof Changes>[0] }).deps,
    });
    again.start();
    p.clock.now += 5_000;
    again.opened(p.db, DALE);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await (
      again as unknown as { attached: { photos: { idle(): Promise<void> } } }
    ).attached.photos.idle();
    expect(p.storage.requests.slice(3)).toEqual([
      'head',
      `piece ${PIECE_BYTES}`,
      `piece ${2 * PIECE_BYTES}`,
    ]);
    expect(p.row(photo.id).state).toBe('sent');
    expect(p.api.ran()).toEqual(['file.begin_upload', 'file.confirm']);
  });

  it('confirms without uploading again when Storage already has it', async () => {
    const p = phone();
    p.storage.objects.set(`attachments/${LONE_STAR}/person/${MARIA}/${FILE_ID}/Photo.jpg`, 10);
    const photo = await addPhoto(p, MB);
    await p.settle();
    expect(p.row(photo.id).state).toBe('sent');
    expect(p.api.ran()).toEqual(['file.begin_upload', 'file.confirm']);
  });

  it('tries again later, a little longer each time, when the upload fails', async () => {
    const p = phone();
    p.storage.failNext = ['whole', 'whole'];
    const photo = await addPhoto(p, MB);
    await p.settle();
    expect(photoRow(p, photo.id)).toMatchObject({ step: 'upload', tries: 1 });
    await p.advance(5_000);
    expect(photoRow(p, photo.id)).toMatchObject({ step: 'upload', tries: 2 });
    await p.advance(14_000);
    expect(p.row(photo.id).state).toBe('waiting');
    await p.advance(1_000);
    expect(p.row(photo.id).state).toBe('sent');
  });

  it('uploads again under a new confirm id when HandsFreeOS says it never arrived, then gives up with its words', async () => {
    const p = phone();
    const notUploaded = (r: { name: string }) =>
      r.name === 'file.confirm'
        ? refusal(409, 'final', 'The file has not finished uploading.', {
            rule: 'file_not_uploaded',
          })
        : undefined;
    p.api.script(notUploaded);
    const photo = await addPhoto(p, MB);
    await p.settle();
    const confirms = p.api.sent('file.confirm');
    expect(confirms).toHaveLength(2);
    expect(confirms[0]!.commandId).not.toBe(confirms[1]!.commandId);
    expect(p.row(photo.id).state).toBe('sent');
    expect(photoRow(p, photo.id)).toMatchObject({ upload_rounds: 1 });

    // Refused every time: after the rounds, it's refused with the API's words, and what waits for it is held.
    const q = phone();
    const stop = q.api.always(notUploaded);
    const second = await addPhoto(q, MB);
    const note = await q.changes.change(
      'activity.log',
      { workspaceId: LONE_STAR, personId: MARIA, kind: 'note', body: 'About the photo' },
      { dependsOn: [second.id] },
    );
    await q.settle();
    await q.sync();
    expect(q.api.sent('file.confirm')).toHaveLength(UPLOAD_ROUNDS + 1);
    expect(q.row(second.id)).toMatchObject({
      state: 'refused',
      reason: 'The file has not finished uploading.',
    });
    expect(q.row(note.id).state).toBe('held');
    // "Try again" goes through every step again, and releases the note once it's confirmed.
    stop();
    await q.changes.tryPhotoAgain(second.id);
    await q.settle();
    expect(q.row(second.id).state).toBe('sent');
    await q.sync();
    expect(q.row(note.id).state).toBe('sent');
  });

  it('refused outright is kept with the API’s words, and never retried on its own', async () => {
    const p = phone();
    p.api.script((r) =>
      r.name === 'file.begin_upload' ? refusal(404, 'final', 'Record not found.') : undefined,
    );
    const photo = await addPhoto(p, MB);
    await p.settle();
    expect(p.row(photo.id)).toMatchObject({ state: 'refused', reason: 'Record not found.' });
    await p.advance(10 * 60_000);
    expect(p.api.sent()).toHaveLength(1);
  });

  it('for a customer made offline waits until they’re saved', async () => {
    const p = phone({ online: false });
    const person = await p.changes.change('person.create', {
      workspaceId: LONE_STAR,
      firstName: 'Rosa',
      lastName: 'Delgado',
    });
    const photo = await addPhoto(p, MB, { dependsOn: [person.id] });
    p.setOnline(true);
    await p.settle();
    expect(p.row(photo.id)).toMatchObject({
      state: 'held',
      reason: 'Held until Rosa Delgado is saved, then it goes.',
    });
    expect(p.api.sent()).toEqual([]);
    await p.sync();
    await p.settle();
    expect(p.api.ran()).toEqual(['person.create', 'file.begin_upload', 'file.confirm']);
  });

  it('is deleted from the phone when discarded', async () => {
    const p = phone({ online: false });
    const photo = await addPhoto(p, MB);
    await p.changes.discard([photo.id]);
    expect(p.storage.exists(`${FILE_ID}.jpg`)).toBe(false);
    expect(p.db.rows('SELECT * FROM photo_uploads')).toEqual([]);
    expect(p.api.sent()).toEqual([]);
  });
});
