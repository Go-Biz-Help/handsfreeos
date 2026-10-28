import type { paths } from '@hfos/api-client';
import { holds, type DocumentStatus } from '@hfos/core';

import { useGrants } from '@/lib/grants';
import { api, unwrap } from '@/lib/api';
import { workerPost } from '@/lib/worker';

/**
 * Documents from the phone (docs/documents.md, part 3), as the web's screens make the same calls: what's been sent, one
 * document, the templates that are ready, what the Send screen starts from, and the changes a document's page makes.
 * None of it is in the phone's copy, and none of it waits in the queue: a document goes out, or is reminded or voided,
 * as HandsFreeOS has it now.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;
type Body<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export type DocumentRow = Ok<'/v1/queries/document.list'>['documents'][number];
export type DocumentGetOut = Ok<'/v1/queries/document.get'>;
export type DocumentSignerRow = DocumentGetOut['signers'][number];
export type DocumentTemplateRow = Ok<'/v1/queries/document_template.list'>['templates'][number];
export type DocumentPrefillOut = Ok<'/v1/queries/document.prefill'>;
export type DocumentSendBody = Body<'/v1/commands/document.send'>;
export type DocumentAboutInput = DocumentSendBody['about'];

/** Who sends documents, as the commands check it; it's also who sees Documents in More. */
export const DOCUMENTS_SEND = 'documents.send';

export function useSendsDocuments(): boolean {
  return holds(useGrants(), DOCUMENTS_SEND);
}

/** A teammate to sign for the business or get a copy: the business's people and its organisation's admins, once each. */
export interface TeamMember {
  readonly id: string;
  readonly fullName: string;
}

export function documentCalls(workspaceId: string) {
  return {
    list: async (
      filter: {
        readonly status?: DocumentStatus;
        readonly personId?: string;
        readonly before?: string;
        readonly limit?: number;
      } = {},
    ) =>
      unwrap(
        await api.POST('/v1/queries/document.list', {
          body: { workspaceId, limit: filter.limit ?? 50, ...filter },
        }),
      ),
    get: async (documentId: string): Promise<DocumentGetOut> =>
      unwrap(await api.POST('/v1/queries/document.get', { body: { workspaceId, documentId } })),
    /** The templates that can go out: in use and ready. */
    templates: async (): Promise<DocumentTemplateRow[]> =>
      unwrap(
        await api.POST('/v1/queries/document_template.list', { body: { workspaceId } }),
      ).templates.filter((t) => t.ready && !t.archivedAt),
    prefill: async (
      templateId: string,
      about: DocumentAboutInput,
      fromDocumentId: string | null,
    ): Promise<DocumentPrefillOut> =>
      unwrap(
        await api.POST('/v1/queries/document.prefill', {
          body: {
            workspaceId,
            templateId,
            about,
            ...(fromDocumentId ? { fromDocumentId } : {}),
          },
        }),
      ),
    members: async (): Promise<TeamMember[]> => {
      const got = unwrap(
        await api.POST('/v1/queries/workspace.members', { body: { workspaceId } }),
      );
      const seen = new Set<string>();
      const out: TeamMember[] = [];
      for (const m of [...got.members, ...got.organizationAdmins]) {
        if (seen.has(m.userId)) continue;
        seen.add(m.userId);
        out.push({ id: m.userId, fullName: m.fullName || m.email });
      }
      return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
    send: async (body: Omit<DocumentSendBody, 'workspaceId'>) =>
      unwrap(await api.POST('/v1/commands/document.send', { body: { ...body, workspaceId } })),
    remind: async (documentId: string) =>
      unwrap(await api.POST('/v1/commands/document.remind', { body: { workspaceId, documentId } })),
    void: async (documentId: string, reason: string) =>
      unwrap(
        await api.POST('/v1/commands/document.void', {
          body: { workspaceId, documentId, ...(reason ? { reason } : {}) },
        }),
      ),
    /** Sign now (answer 13a): noted as handed over by this person, on the signer's turn only. */
    signNow: async (signerId: string) =>
      unwrap(await api.POST('/v1/commands/document.sign_now', { body: { workspaceId, signerId } })),
    /** A signer's own link, asked as this person, so a customer they can't see is "not there". */
    link: async (signerId: string): Promise<string> =>
      (await workerPost<{ url: string }>('/v1/documents/link', { workspaceId, signerId })).url,
  };
}

export type DocumentCalls = ReturnType<typeof documentCalls>;
