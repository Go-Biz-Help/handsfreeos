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
import {
  ESIGN_PROVIDERS,
  ESIGN_STATES,
  signersWords,
  type EsignProvider,
  type EsignSigner,
  type EsignState,
} from '../esign';
import type { DocumentListOutput, EsignListOutput } from '../schemas';
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

type Envelope = z.infer<typeof EsignListOutput>['envelopes'][number];
/** A document sent for signing, as `realestate.esign.list` has it, with who signs next. */
export type DealSigning = Pick<
  Envelope,
  | 'id'
  | 'documentId'
  | 'provider'
  | 'providerLabel'
  | 'state'
  | 'stateLabel'
  | 'signers'
  | 'signersWords'
  | 'sentAt'
  | 'completedAt'
  | 'signedDocumentId'
> & {
  /** The first signer, in signing order, who hasn't signed yet. */
  readonly next: string | null;
};

/**
 * A deal's documents sent for signing through DocuSign or Dotloop (board 81: "DocuSign · 1 of 2 signed · Bill Smith
 * next"), newest sent first, from the envelopes the phone keeps. A deal kept as its summary has none.
 */
export function signingsOfCopy(copy: RealestateCopy, dealId: string): DealSigning[] {
  return copy
    .rows('esign_envelopes', dealId)
    .map(({ id, data: e }) => {
      const provider = (text(e.provider) ?? 'docusign') as EsignProvider;
      const state = (text(e.state) ?? 'preparing') as EsignState;
      const signers = (Array.isArray(e.signers) ? e.signers : []) as EsignSigner[];
      const next = [...signers].sort((a, b) => a.order - b.order).find((s) => s.state !== 'signed');
      return {
        id,
        documentId: text(e.document_id) ?? '',
        provider,
        providerLabel: ESIGN_PROVIDERS[provider],
        state,
        stateLabel: ESIGN_STATES[state],
        signers,
        signersWords: signersWords(signers),
        sentAt: isoOr(e.sent_at),
        completedAt: isoOr(e.completed_at),
        signedDocumentId: text(e.signed_document_id),
        next: next?.name ?? null,
      };
    })
    .sort((a, b) => byText(b.sentAt ?? '', a.sentAt ?? '') || byText(b.id, a.id));
}
