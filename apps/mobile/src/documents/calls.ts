import type { paths } from '@hfos/api-client';
import {
  DOCUMENT_EDITOR_WORDS as E,
  holds,
  MAX_DOCUMENT_PAGES,
  TEMPLATE_PDF_MAX_BYTES,
  type DocumentDefinition,
  type DocumentField,
  type DocumentRole,
  type DocumentStatus,
  type DocumentTextLine,
} from '@hfos/core';
import { File, UploadType } from 'expo-file-system';

import { useGrants } from '@/lib/grants';
import { api, ApiError, unwrap } from '@/lib/api';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { workerPost } from '@/lib/worker';

/**
 * Documents from the phone (docs/documents.md, part 3), as the web's screens make the same calls: what's been sent, one
 * document, the templates, what the Send screen starts from, and the changes a document's page and a template's editor
 * make. A PDF's pages come from the worker, which draws them for the phone (apps/worker/src/documents/pages.ts). None
 * of it is in the phone's copy, and none of it waits in the queue: a document goes out, or is reminded or voided, and a
 * template is saved, as HandsFreeOS has it now.
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
export type DocumentTemplateGetOut = Ok<'/v1/queries/document_template.get'>;
export type DocumentIssueRow = DocumentTemplateGetOut['issues'][number];

/** A line of a page's words as the worker read it, with the paper's colour behind it and the ink's. */
export interface PageLine extends DocumentTextLine {
  readonly background: string;
  readonly color: string;
}

/** A page drawn by the worker: its picture (a link for an hour) and its lines of words. */
export interface PagePicture {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly picture: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly lines: readonly PageLine[];
}

export interface DocumentPagesOut {
  readonly pageCount: number;
  /** For a PDF just uploaded: every page's size, for `document_template.set_source`. */
  readonly sizes?: readonly { width: number; height: number }[];
  readonly pages: readonly PagePicture[];
}

/** Whose PDF: a template's, or a sent document's. */
export type PagesSource = { readonly templateId: string } | { readonly documentId: string };

/** A PDF picked on the phone. */
export interface PickedPdf {
  readonly uri: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
}

/** Who makes and changes templates. */
export const DOCUMENTS_MANAGE = 'documents.manage';

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

    // ---------- templates ----------
    templateList: async (archived = false): Promise<DocumentTemplateRow[]> =>
      unwrap(
        await api.POST('/v1/queries/document_template.list', { body: { workspaceId, archived } }),
      ).templates,
    templateGet: async (templateId: string): Promise<DocumentTemplateGetOut> =>
      unwrap(
        await api.POST('/v1/queries/document_template.get', { body: { workspaceId, templateId } }),
      ),
    templateCreate: async (name: string) =>
      unwrap(
        await api.POST('/v1/commands/document_template.create', { body: { workspaceId, name } }),
      ),
    templateRename: async (templateId: string, name: string) =>
      unwrap(
        await api.POST('/v1/commands/document_template.rename', {
          body: { workspaceId, templateId, name },
        }),
      ),
    templateDuplicate: async (templateId: string) =>
      unwrap(
        await api.POST('/v1/commands/document_template.duplicate', {
          body: { workspaceId, templateId },
        }),
      ),
    templateArchive: async (templateId: string) =>
      unwrap(
        await api.POST('/v1/commands/document_template.archive', {
          body: { workspaceId, templateId },
        }),
      ),
    templateRestore: async (templateId: string) =>
      unwrap(
        await api.POST('/v1/commands/document_template.restore', {
          body: { workspaceId, templateId },
        }),
      ),
    /** The whole definition, with the revision it started from: someone else's save in between is a conflict. */
    templateSave: async (
      templateId: string,
      baseRevision: number,
      definition: DocumentDefinition,
    ) =>
      unwrap(
        await api.POST('/v1/commands/document_template.save', {
          body: { workspaceId, templateId, baseRevision, definition: definition as never },
        }),
      ),
    /** A few of a PDF's pages, drawn by the worker. */
    pages: (source: PagesSource, from: number, count: number): Promise<DocumentPagesOut> =>
      workerPost<DocumentPagesOut>('/v1/documents/pages', {
        workspaceId,
        ...source,
        from,
        count,
      }),
    /** "Place fields for me" (answer 4a): the worker finds the spots on the template's PDF, and the AI labels them. */
    placeFields: async (templateId: string, roles: readonly DocumentRole[]) =>
      (
        await workerPost<{ fields: DocumentField[] }>('/v1/documents/place-fields', {
          workspaceId,
          templateId,
          roles,
        })
      ).fields,
    /**
     * A template's PDF from the phone: checked, uploaded to the place `document_template.begin_upload` keeps for it,
     * confirmed, read by the worker for its pages' sizes (the phone can't read a PDF), and made the template's own
     * with `document_template.set_source`.
     */
    uploadTemplatePdf: async (templateId: string, picked: PickedPdf, baseRevision: number) => {
      const wrong = pdfProblem(picked);
      if (wrong) throw new Error(wrong);
      const begun = unwrap(
        await api.POST('/v1/commands/document_template.begin_upload', {
          body: {
            workspaceId,
            templateId,
            name: picked.name,
            mimeType: 'application/pdf',
            sizeBytes: picked.size,
          },
        }),
      );
      const token = await session.accessToken();
      if (!token) throw new ApiError('Sign in to continue.', 401, 'unauthenticated', null);
      let sent: { status: number };
      try {
        sent = await new File(picked.uri).upload(
          `${config.supabaseUrl}/storage/v1/object/${begun.bucket}/${begun.objectPath}`,
          {
            httpMethod: 'POST',
            uploadType: UploadType.BINARY_CONTENT,
            headers: {
              authorization: `Bearer ${token}`,
              apikey: config.supabasePublishableKey,
              'content-type': 'application/pdf',
              'x-upsert': 'false',
            },
            mimeType: 'application/pdf',
          },
        );
      } catch {
        // No signal, as errorMessage words it.
        throw new TypeError('Network request failed');
      }
      if (sent.status >= 400) throw new Error(E.didntUpload(picked.name));
      unwrap(
        await api.POST('/v1/commands/file.confirm', {
          body: { workspaceId, fileId: begun.fileId },
        }),
      );
      const read = await workerPost<DocumentPagesOut>('/v1/documents/pages', {
        workspaceId,
        templateId,
        fileId: begun.fileId,
        count: 1,
      });
      const pages = read.sizes ?? [];
      if (!pages.length) throw new Error(E.noPages(picked.name));
      if (pages.length > MAX_DOCUMENT_PAGES)
        throw new Error(E.tooManyPages(picked.name, pages.length));
      return unwrap(
        await api.POST('/v1/commands/document_template.set_source', {
          body: { workspaceId, templateId, fileId: begun.fileId, pages: [...pages], baseRevision },
        }),
      );
    },
  };
}

/** Why a file picked can't be a template's PDF: it isn't one, or it's too big. */
export function pdfProblem(picked: PickedPdf): string | null {
  const isPdf = picked.mimeType === 'application/pdf' || picked.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) return E.notPdf(picked.name);
  if (picked.size > TEMPLATE_PDF_MAX_BYTES) return E.tooBig(picked.name);
  return null;
}

/** A PDF from the phone's files, or null when they didn't pick one. */
export async function pickPdf(): Promise<PickedPdf | null> {
  const got = await File.pickFileAsync({ mimeTypes: ['application/pdf'] });
  if (got.canceled) return null;
  const f = got.result;
  return { uri: f.uri, name: f.name, size: f.size, mimeType: f.type || 'application/pdf' };
}

export function useManagesTemplates(): boolean {
  return holds(useGrants(), DOCUMENTS_MANAGE);
}

export type DocumentCalls = ReturnType<typeof documentCalls>;
