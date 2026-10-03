import type { DocumentKind } from '@hfos/core/addons/realestate/catalog/types';
import type { ContingencyEnding } from '@hfos/core/addons/realestate/contingencies';
import type { VendorService } from '@hfos/core/addons/realestate/vendors';

import { change, changes, newId, type ChangeOptions } from '@/changes';
import { takePhoto, type PhotoSource } from '@/changes/photo-device';

/**
 * The changes a deal's screens make (boards 76–81 and 93): a duty's proof and marking it done, a contingency
 * resolved, a document from a photo of a paper, a client update checked and OK'd, a vendor added, and what needs
 * signal (an exception, export, a hold, a stage, a draft from the AI, a contract's values). Each is a command through
 * `change`; the ones that may wait with no signal write what the person should see at once into the synced rows, in the
 * same transaction, and leave at the next checkpoint once the change is handled.
 *
 * Real Estate's rows on the phone are `addon_phone_rows`, keyed `<source>:<the row's key>`, their columns as JSON.
 */

const nowIso = () => new Date().toISOString();
const rowId = (source: string, id: string) => `${source}:${id}`;

type Tx = Parameters<NonNullable<ChangeOptions['optimistic']>>[0];

/** A new row of one of Real Estate's sources on a deal, as the phone will be sent it. */
function insertRow(
  tx: Tx,
  workspaceId: string,
  source: string,
  dealId: string,
  id: string,
  data: Record<string, unknown>,
) {
  return tx.execute(
    `INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
     VALUES (?, ?, 'realestate', ?, ?, ?, ?)`,
    [rowId(source, id), workspaceId, source, dealId, JSON.stringify(data), nowIso()],
  );
}

// ---------------------------------------------------------------------------------------------- photos

export type TakenPhoto =
  | { readonly kind: 'kept'; readonly changeId: string; readonly fileId: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

/**
 * Takes (or picks) a photo and puts it on the deal's files through the phone's photo track: kept in the person's photos
 * folder and uploaded when there's signal. Resolves with the photo's change id, for what waits on it.
 */
export async function photoOnDeal(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dealId: string;
  readonly source: PhotoSource;
  readonly name?: string;
}): Promise<TakenPhoto> {
  const fileId = newId();
  const taken = await takePhoto({ userId: input.userId, source: input.source, fileId });
  if (taken.kind !== 'kept') return taken;
  const added = await changes.addPhoto(
    { workspaceId: input.workspaceId, recordType: 'custom_record', recordId: input.dealId },
    { localName: taken.photo.localName, sizeBytes: taken.photo.sizeBytes },
    { fileId, ...(input.name ? { name: input.name } : {}) },
  );
  return { kind: 'kept', changeId: added.id, fileId };
}

// ---------------------------------------------------------------------------------------------- documents

/**
 * A document on the deal from a file already on it (a photo just taken): with the phone's id, so a duty's proof or a
 * contingency's form can point at it before it arrives. Waits for the photo.
 */
export async function addDocument(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly fileId: string;
  readonly kind: DocumentKind;
  readonly title?: string;
  readonly status?: 'draft' | 'sent';
  readonly dependsOn?: readonly string[];
}): Promise<{ readonly changeId: string; readonly documentId: string }> {
  const documentId = newId();
  const title = input.title?.trim() || undefined;
  const made = await change(
    'realestate.document.add',
    {
      workspaceId: input.workspaceId,
      dealId: input.dealId,
      id: documentId,
      fileId: input.fileId,
      kind: input.kind,
      ...(title ? { title } : {}),
      status: input.status ?? 'draft',
    },
    {
      dependsOn: input.dependsOn ?? [],
      optimistic: (tx) =>
        insertRow(tx, input.workspaceId, 'documents', input.dealId, documentId, {
          file_id: input.fileId,
          kind: input.kind,
          title: title ?? null,
          lineage_id: documentId,
          version: 1,
          supersedes_id: null,
          status: input.status ?? 'draft',
          controlling: false,
          signed_at: null,
          voided_at: null,
          void_reason: null,
          offer_version_id: null,
          created_at: nowIso(),
        }),
    },
  );
  return { changeId: made.id, documentId };
}

// ---------------------------------------------------------------------------------------------- a duty's proof

interface DutyRef {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dealId: string;
  readonly dutyId: string;
}

type Evidence =
  | { readonly kind: 'note' | 'attestation'; readonly body: string }
  | { readonly kind: 'document'; readonly documentId: string }
  | { readonly kind: 'file'; readonly fileId: string };

/** Proof on a duty, with no signal: a note, the person's word, one of the deal's documents, or a file. */
export function addEvidence(
  ref: DutyRef,
  evidence: Evidence,
  dependsOn: readonly string[] = [],
): Promise<{ readonly id: string }> {
  const id = newId();
  const body = 'body' in evidence ? evidence.body.trim() : undefined;
  return change(
    'realestate.duty.add_evidence',
    {
      workspaceId: ref.workspaceId,
      dutyId: ref.dutyId,
      id,
      kind: evidence.kind,
      ...(body ? { body } : {}),
      ...(evidence.kind === 'document' ? { documentId: evidence.documentId } : {}),
      ...(evidence.kind === 'file' ? { fileId: evidence.fileId } : {}),
    },
    {
      dependsOn,
      optimistic: (tx) =>
        insertRow(tx, ref.workspaceId, 'duty_evidence', ref.dealId, id, {
          duty_id: ref.dutyId,
          kind: evidence.kind,
          document_id: evidence.kind === 'document' ? evidence.documentId : null,
          file_id: evidence.kind === 'file' ? evidence.fileId : null,
          appointment_id: null,
          message_id: null,
          body: body ?? null,
          added_by: ref.userId,
          added_at: nowIso(),
          withdrawn_at: null,
          withdrawn_reason: null,
        }),
    },
  );
}

/**
 * A photo as a duty's proof: when its proof asks for a document of some kind, the photo becomes that document (a
 * binder, a receipt) and the document is the proof; otherwise it's a file on the deal. Every step waits on the one
 * before it, so it all goes, in order, when there's signal.
 */
export async function addPhotoEvidence(
  ref: DutyRef,
  source: PhotoSource,
  asDocument: { readonly kind: DocumentKind; readonly title: string } | null,
): Promise<TakenPhoto['kind']> {
  const photo = await photoOnDeal({
    workspaceId: ref.workspaceId,
    userId: ref.userId,
    dealId: ref.dealId,
    source,
  });
  if (photo.kind !== 'kept') return photo.kind;
  if (asDocument) {
    const doc = await addDocument({
      workspaceId: ref.workspaceId,
      dealId: ref.dealId,
      fileId: photo.fileId,
      kind: asDocument.kind,
      title: asDocument.title,
      dependsOn: [photo.changeId],
    });
    await addEvidence(ref, { kind: 'document', documentId: doc.documentId }, [doc.changeId]);
  } else {
    await addEvidence(ref, { kind: 'file', fileId: photo.fileId }, [photo.changeId]);
  }
  return 'kept';
}

/** Marks a duty done with no signal: it counts at HandsFreeOS when it arrives, from the moment it was done here. */
export function completeDuty(ref: Omit<DutyRef, 'userId' | 'dealId'>) {
  return change(
    'realestate.duty.complete',
    { workspaceId: ref.workspaceId, dutyId: ref.dutyId },
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows SET data = json_set(data, '$.status', 'completed', '$.finished_at', ?)
           WHERE id = ?`,
          [nowIso(), rowId('duties', ref.dutyId)],
        ),
    },
  );
}

/** Done without its proof, with the reason (owners and admins): HandsFreeOS checks it first, so it needs signal. */
export function completeWithException(workspaceId: string, dutyId: string, reason: string) {
  return change('realestate.duty.complete_with_exception', {
    workspaceId,
    dutyId,
    reason: reason.trim(),
  });
}

/** An escalated duty, acknowledged: its alerts stop climbing. */
export function acknowledgeDuty(workspaceId: string, dutyId: string) {
  return change(
    'realestate.duty.acknowledge',
    { workspaceId, dutyId },
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows SET data = json_set(data, '$.acknowledged_at', ?) WHERE id = ?`,
          [nowIso(), rowId('duties', dutyId)],
        ),
    },
  );
}

// ---------------------------------------------------------------------------------------------- contingencies

/**
 * How a contingency ended, with the signed form (one of the deal's documents, or a photo of it made a document here).
 * Works with no signal; the dates and duties it moves, move at HandsFreeOS when it arrives.
 */
export function resolveContingency(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly contingencyId: string;
  readonly how: ContingencyEnding;
  readonly documentId: string;
  readonly dependsOn?: readonly string[];
}) {
  return change(
    'realestate.contingency.resolve',
    {
      workspaceId: input.workspaceId,
      contingencyId: input.contingencyId,
      how: input.how,
      documentId: input.documentId,
    },
    {
      dependsOn: input.dependsOn ?? [],
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows
           SET data = json_set(data, '$.state', ?, '$.resolved_at', ?, '$.resolved_by', ?, '$.document_id', ?)
           WHERE id = ?`,
          [
            input.how,
            nowIso(),
            input.userId,
            input.documentId,
            rowId('contingencies', input.contingencyId),
          ],
        ),
    },
  );
}

// ---------------------------------------------------------------------------------------------- client updates

/** A client update's words, changed: checked for fair housing again when it arrives. */
export function saveUpdate(
  workspaceId: string,
  draftId: string,
  words: { readonly subject: string; readonly body: string },
) {
  const at = nowIso();
  return change(
    'realestate.status_email.save',
    { workspaceId, draftId, subject: words.subject.trim(), body: words.body.trim() },
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows SET data = json_set(data, '$.subject', ?, '$.body', ?, '$.edited_at', ?)
           WHERE id = ?`,
          [words.subject.trim(), words.body.trim(), at, rowId('drafts', draftId)],
        ),
    },
  );
}

/** OK'd: it goes to the client while fresh, and asks "Still send?" after 30 minutes on the phone. */
export function sendUpdate(
  workspaceId: string,
  draftId: string,
  dependsOn: readonly string[] = [],
) {
  return change('realestate.status_email.send', { workspaceId, draftId }, { dependsOn });
}

/** The AI writes a client update: it needs signal. */
export function requestUpdate(workspaceId: string, dealId: string) {
  return change('realestate.status_email.request', { workspaceId, dealId });
}

// ---------------------------------------------------------------------------------------------- the deal

/** A note on the deal, with no signal (a field note about the deal itself). */
export function addDealNote(workspaceId: string, dealId: string, body: string) {
  return change('realestate.field_note.add', {
    workspaceId,
    dealId,
    id: newId(),
    aboutKind: 'deal',
    body: body.trim(),
  });
}

/** The deal moves to a stage. */
export function moveStage(workspaceId: string, dealId: string, stage: string) {
  return change('realestate.deal.move_stage', { workspaceId, dealId, stage });
}

/** The whole transaction, exported: needs signal; the worker makes the file. */
export function exportDeal(workspaceId: string, dealId: string) {
  return change('realestate.deal.export', { workspaceId, dealId });
}

export function placeHold(workspaceId: string, dealId: string, reason: string) {
  return change('record_hold.place', {
    workspaceId,
    customRecordId: dealId,
    reason: reason.trim(),
  });
}

export function liftHold(workspaceId: string, holdId: string, reason: string) {
  return change('record_hold.lift', { workspaceId, holdId, reason: reason.trim() });
}

/** Every value of a reading still waiting, confirmed: needs signal (it moves the deal's dates and duties). */
export function confirmValues(workspaceId: string, readId: string) {
  return change('realestate.contract.confirm', { workspaceId, readId });
}

// ---------------------------------------------------------------------------------------------- vendors

export interface NewVendor {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly services: readonly VendorService[];
  readonly areas: readonly string[];
  readonly disclosure?: string;
}

/** A vendor added with no signal, as a company in Contacts; an owner or admin approves them with signal. */
export function addVendor(workspaceId: string, vendor: NewVendor) {
  const phone = vendor.phone?.trim();
  const email = vendor.email?.trim();
  const disclosure = vendor.disclosure?.trim();
  return change('realestate.vendor.save', {
    workspaceId,
    id: newId(),
    name: vendor.name.trim(),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    services: [...vendor.services],
    areas: [...vendor.areas],
    ...(disclosure ? { disclosure } : {}),
  });
}

export function approveVendor(workspaceId: string, vendorId: string) {
  return change('realestate.vendor.approve', { workspaceId, vendorId, approved: true });
}
