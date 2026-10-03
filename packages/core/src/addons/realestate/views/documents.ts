/**
 * A deal's documents from a phone's copy (Real Estate round six, step 14): what `realestate.document.list` answers,
 * worked out from the rows the phone keeps. The files themselves stay at HandsFreeOS and open with signal (Chris,
 * 2026-10-03); names, versions, who signed and what's locked are on the phone. A deal kept as its summary has none.
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds it to the server's answer.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { DOCUMENT_KINDS, type DocumentKind } from '../catalog/types';
import type { DocumentListOutput } from '../schemas';
import { isoOr } from './deal-facts';
import { byText, iso, text, type RealestateCopy } from './synced';

export type DealDocument = z.infer<typeof DocumentListOutput>['documents'][number];

export function documentsOfCopy(copy: RealestateCopy, dealId: string): DealDocument[] {
  return copy
    .rows('documents', dealId)
    .flatMap(({ id, data: d }) => {
      const fileId = text(d.file_id);
      // As on the server: a document shows with its file, which the phone holds for the deal's people.
      const fileName = fileId ? copy.file(fileId) : null;
      if (!fileId || fileName === null) return [];
      const kind = text(d.kind) ?? '';
      return [
        {
          documentId: id,
          fileId,
          fileName,
          kind,
          kindLabel: DOCUMENT_KINDS[kind as DocumentKind] ?? kind,
          title: text(d.title) ?? '',
          lineageId: text(d.lineage_id) ?? '',
          version: Number(d.version ?? 0) || 0,
          status: (text(d.status) ?? 'draft') as DealDocument['status'],
          controlling: d.controlling === true,
          locked: copy.fileLocked(fileId) === true,
          signedAt: isoOr(d.signed_at),
          voidedAt: isoOr(d.voided_at),
          voidReason: text(d.void_reason),
          createdAt: isoOr(d.created_at) ?? iso(0),
        },
      ];
    })
    .sort(
      (a, b) => byText(a.kind, b.kind) || byText(a.lineageId, b.lineageId) || b.version - a.version,
    );
}
