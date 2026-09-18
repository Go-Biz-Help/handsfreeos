import type { TagRef } from '@hfos/core';

import { change, changes, editedOnly, newId, orNull, tagChanges } from '@/changes';
import type { ChangeTransaction } from '@/changes/controller';

/**
 * What the buttons on a customer, a company or a lead do. Every one of them goes through `change()`, so it works with
 * no signal and waits in the queue; each writes what the person should see into the phone's copy in the same
 * transaction, so the screen moves at once.
 *
 * Edits follow the field-merge rules: **only the details that changed, with the value the person saw** (`base`), so a
 * teammate's later change to another detail is never written back over.
 */

const nowIso = () => new Date().toISOString();

export interface PersonEdit {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  readonly notes: string;
  readonly line1: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

const tidy = (edit: PersonEdit) => ({
  firstName: edit.firstName.trim(),
  lastName: edit.lastName.trim(),
  phone: orNull(edit.phone),
  email: orNull(edit.email),
  notes: orNull(edit.notes),
  line1: orNull(edit.line1),
  city: orNull(edit.city),
  state: orNull(edit.state),
  postalCode: orNull(edit.postalCode),
});

/**
 * Save a customer's details: only what changed goes, each with what the screen showed. The address travels as one
 * detail, as the command takes it.
 */
export async function savePerson(
  workspaceId: string,
  personId: string,
  opened: PersonEdit,
  now: PersonEdit,
): Promise<{ readonly changed: boolean; readonly id?: string }> {
  const was = tidy(opened);
  const is = tidy(now);
  const edited = editedOnly(was, is);
  if (!edited.any) return { changed: false };
  const { line1, city, state, postalCode, ...fields } = edited.changes;
  const addressChanged =
    line1 !== undefined || city !== undefined || state !== undefined || postalCode !== undefined;
  const result = await change(
    'person.update',
    {
      workspaceId,
      personId,
      ...fields,
      ...(addressChanged
        ? {
            address: { line1: is.line1, city: is.city, state: is.state, postalCode: is.postalCode },
          }
        : {}),
      base: {
        ...edited.base,
        ...(addressChanged
          ? {
              address: {
                line1: was.line1,
                city: was.city,
                state: was.state,
                postalCode: was.postalCode,
              },
            }
          : {}),
      },
    } as never,
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE people SET first_name = ?, last_name = ?, phone = ?, email = ?, notes = ?,
             address_line1 = ?, city = ?, state = ?, postal_code = ?, updated_at = ?
           WHERE id = ?`,
          [
            is.firstName,
            is.lastName,
            is.phone,
            is.email,
            is.notes,
            is.line1,
            is.city,
            is.state,
            is.postalCode,
            nowIso(),
            personId,
          ],
        ),
    },
  );
  return { changed: true, id: result.id };
}

export interface CompanyEdit {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
  readonly notes: string;
}

export async function saveCompany(
  workspaceId: string,
  companyId: string,
  opened: CompanyEdit,
  now: CompanyEdit,
): Promise<{ readonly changed: boolean }> {
  const was = {
    name: opened.name.trim(),
    phone: orNull(opened.phone),
    email: orNull(opened.email),
    website: orNull(opened.website),
    notes: orNull(opened.notes),
  };
  const is = {
    name: now.name.trim(),
    phone: orNull(now.phone),
    email: orNull(now.email),
    website: orNull(now.website),
    notes: orNull(now.notes),
  };
  const edited = editedOnly(was, is);
  if (!edited.any) return { changed: false };
  await change(
    'company.update',
    { workspaceId, companyId, ...edited.changes, base: edited.base } as never,
    {
      optimistic: (tx) =>
        tx.execute(
          'UPDATE companies SET name = ?, phone = ?, email = ?, website = ?, notes = ?, updated_at = ? WHERE id = ?',
          [is.name, is.phone, is.email, is.website, is.notes, nowIso(), companyId],
        ),
    },
  );
  return { changed: true };
}

export interface RecordRef {
  readonly workspaceId: string;
  readonly recordType: 'person' | 'company' | 'lead';
  readonly recordId: string;
}

const columnOf = (recordType: RecordRef['recordType']) =>
  recordType === 'person' ? 'person_id' : recordType === 'company' ? 'company_id' : 'lead_id';

/**
 * Add a note to a record's timeline. It shows at once, and goes when there's signal. The row written here carries
 * `author_user_id`, so the entry says who wrote it while it waits — without it the timeline would read "Former
 * member" until HandsFreeOS's own row came down.
 */
export async function addNote(ref: RecordRef, body: string, authorUserId: string): Promise<string> {
  const id = newId();
  const at = nowIso();
  await change(
    'activity.log',
    {
      workspaceId: ref.workspaceId,
      id,
      kind: 'note',
      body: body.trim(),
      occurredAt: at,
      [ref.recordType === 'person'
        ? 'personId'
        : ref.recordType === 'company'
          ? 'companyId'
          : 'leadId']: ref.recordId,
    } as never,
    {
      optimistic: (tx: ChangeTransaction) =>
        tx.execute(
          `INSERT INTO activities (id, workspace_id, kind, ${columnOf(ref.recordType)}, body,
             occurred_at, author_user_id, actor_type, created_at, updated_at)
           VALUES (?, ?, 'note', ?, ?, ?, ?, 'user', ?, ?)`,
          [id, ref.workspaceId, ref.recordId, body.trim(), at, authorUserId, at, at],
        ),
    },
  );
  return id;
}

/**
 * Put the tags a person chose on a record: one change per tag, on and off, never the whole set — so two people tagging
 * the same customer at the same moment both keep theirs.
 */
export async function saveTags(
  ref: RecordRef,
  before: readonly TagRef[],
  after: readonly string[],
): Promise<number> {
  const each = tagChanges(
    ref,
    before.map((t) => t.id),
    after,
  );
  for (const one of each) {
    await change(one.name, one.input, {
      optimistic: (tx) =>
        one.name === 'record.add_tag'
          ? tx.execute(
              `INSERT OR REPLACE INTO record_tags (id, workspace_id, tag_id, record_type, record_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [newId(), ref.workspaceId, one.input.tagId, ref.recordType, ref.recordId, nowIso()],
            )
          : tx.execute('DELETE FROM record_tags WHERE tag_id = ? AND record_id = ?', [
              one.input.tagId,
              ref.recordId,
            ]),
    });
  }
  return each.length;
}

/** Add a photo to a record: it is kept on the phone first and uploads on its own track. */
export async function addPhoto(
  ref: RecordRef,
  file: { readonly localName: string; readonly sizeBytes: number; readonly fileId: string },
  name?: string,
): Promise<string> {
  const added = await changes.addPhoto(
    { workspaceId: ref.workspaceId, recordType: ref.recordType, recordId: ref.recordId },
    { localName: file.localName, sizeBytes: file.sizeBytes },
    { fileId: file.fileId, name },
  );
  return added.id;
}

/** Archive or restore a customer or a company. */
export async function archiveRecord(
  ref: RecordRef,
  archived: boolean,
): Promise<{ readonly id: string }> {
  const at = archived ? null : nowIso();
  if (ref.recordType === 'person')
    return change(
      archived ? 'person.restore' : 'person.archive',
      { workspaceId: ref.workspaceId, personId: ref.recordId } as never,
      {
        optimistic: (tx) =>
          tx.execute('UPDATE people SET archived_at = ? WHERE id = ?', [at, ref.recordId]),
      },
    );
  return change(
    archived ? 'company.restore' : 'company.archive',
    { workspaceId: ref.workspaceId, companyId: ref.recordId } as never,
    {
      optimistic: (tx) =>
        tx.execute('UPDATE companies SET archived_at = ? WHERE id = ?', [at, ref.recordId]),
    },
  );
}
