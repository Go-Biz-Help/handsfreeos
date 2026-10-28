/**
 * Documents to sign (20261027015200): templates from a PDF, sending one, and what the worker records as people sign.
 * A definition is a tree, so it goes out as a JSON object and core's DocumentDefinition reads it. Browser-safe.
 */
import { z } from 'zod';
import {
  DOCUMENT_ORDERS,
  DocumentDefinition,
  DocumentEdit,
  DocumentItemId,
  DocumentValue,
  MAX_DOCUMENT_COPIES,
  MAX_DOCUMENT_EDITS,
  MAX_DOCUMENT_ROLES,
  DocumentRoleKey,
} from '../documents/definition';
import { DOCUMENT_STATUSES, DOCUMENT_STEP_KINDS, SIGNER_STATUSES } from '../documents/words';
import { isoDateTime, uuid } from './common';

const templateName = z
  .string()
  .trim()
  .min(1, 'Name the template.')
  .max(120, 'Keep the name under 120 characters.');
const baseRevision = z.int().min(1);
const json = z.record(z.string(), z.unknown());

export const DocumentStatusValue = z.enum(DOCUMENT_STATUSES);
export const SignerStatusValue = z.enum(SIGNER_STATUSES);
export const DocumentStepKindValue = z.enum(DOCUMENT_STEP_KINDS);

/** What stops a template going out (core's templateIssues). */
export const DocumentIssueOut = z.object({
  rule: z.string(),
  message: z.string(),
  role: z.string().optional(),
});

/** The one record a document is about: a customer, a company, a lead or a record of the business's own kind. */
export const DocumentAboutInput = z
  .object({
    personId: uuid.optional(),
    companyId: uuid.optional(),
    leadId: uuid.optional(),
    customRecordId: uuid.optional(),
  })
  .refine(
    (a) => [a.personId, a.companyId, a.leadId, a.customRecordId].filter(Boolean).length === 1,
    { error: 'Pick the one customer, company, lead or record it’s about.' },
  );
export const DocumentAboutOut = z.object({
  kind: z.enum(['person', 'company', 'lead', 'custom_record']),
  id: uuid,
  name: z.string(),
});

// ---------- templates ----------

export const DocumentTemplateRefInput = z.object({ workspaceId: uuid, templateId: uuid });

export const DocumentTemplateCreateInput = z.object({ workspaceId: uuid, name: templateName });
export const DocumentTemplateCreateOutput = z.object({ templateId: uuid, revision: z.int() });

/** Reserving a place for the template's PDF; upload it there, then file.confirm, then document_template.set_source. */
export const DocumentTemplateBeginUploadInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  name: z.string().trim().min(1).max(200),
  mimeType: z.literal('application/pdf', { error: 'A template is made from a PDF.' }),
  sizeBytes: z
    .int()
    .min(1)
    .max(25 * 1024 * 1024, 'A template’s PDF can be up to 25 MB.'),
});
export const DocumentTemplateBeginUploadOutput = z.object({
  fileId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});

export const DocumentTemplateSetSourceInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  fileId: uuid,
  /** Each page's size in points, as the editor read them from the PDF. */
  pages: z
    .array(
      z.object({
        width: z.number().positive().max(14_400),
        height: z.number().positive().max(14_400),
      }),
    )
    .min(1, 'That PDF has no pages.')
    .max(100, 'A template’s PDF can have up to 100 pages.'),
  baseRevision,
});
export const DocumentTemplateSetSourceOutput = z.object({
  templateId: uuid,
  revision: z.int(),
  /** Fields and word changes taken off because their page isn’t in the new PDF, or the words they covered changed. */
  removedFields: z.int(),
  removedEdits: z.int(),
});

export const DocumentTemplateSaveInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  baseRevision,
  /** The whole definition as it should be. Its pages come from the PDF and are kept as they are. */
  definition: DocumentDefinition,
});
export const DocumentTemplateSaveOutput = z.object({
  templateId: uuid,
  revision: z.int(),
  changed: z.boolean(),
  issues: z.array(DocumentIssueOut),
});

export const DocumentTemplateRenameInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  name: templateName,
});
export const DocumentTemplateOkOutput = z.object({ templateId: uuid, changed: z.boolean() });

export const DocumentTemplateDuplicateInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  name: templateName.optional(),
});

export const DocumentTemplateListInput = z.object({
  workspaceId: uuid,
  archived: z.boolean().default(false),
});
export const DocumentTemplateSummaryOut = z.object({
  id: uuid,
  name: z.string(),
  pageCount: z.int(),
  roles: z.array(z.object({ key: z.string(), label: z.string(), kind: z.string() })),
  fieldCount: z.int(),
  hasPdf: z.boolean(),
  /** Nothing stops it going out. */
  ready: z.boolean(),
  documentsOut: z.int(),
  updatedAt: isoDateTime,
  archivedAt: isoDateTime.nullable(),
});
export const DocumentTemplateListOutput = z.object({
  templates: z.array(DocumentTemplateSummaryOut),
});

export const DocumentFileOut = z.object({
  fileId: uuid,
  name: z.string(),
  bucket: z.string(),
  objectPath: z.string(),
});

export const DocumentTemplateGetOutput = z.object({
  id: uuid,
  name: z.string(),
  revision: z.int(),
  definition: json,
  source: DocumentFileOut.nullable(),
  issues: z.array(DocumentIssueOut),
  documentsOut: z.int(),
  updatedAt: isoDateTime,
  archivedAt: isoDateTime.nullable(),
});

// ---------- sending ----------

/** Someone who signs: a customer for a customer's role, someone from the team for a team's. */
export const DocumentSignerInput = z
  .object({
    roleKey: DocumentRoleKey,
    personId: uuid.optional(),
    userId: uuid.optional(),
    /** With the team now (answer 13a): no link at their turn; they sign on the team's device with Sign now. */
    inPerson: z.boolean().default(false),
  })
  .refine((s) => !!s.personId !== !!s.userId, {
    error: 'Pick the customer, or the person from your team, who signs.',
  });

/** Someone who gets the signed copy only. */
export const DocumentCopyInput = z
  .object({ personId: uuid.optional(), userId: uuid.optional() })
  .refine((s) => !!s.personId !== !!s.userId, { error: 'Pick who gets a copy.' });

export const DocumentSendSettingsInput = z.object({
  order: z.enum(DOCUMENT_ORDERS).optional(),
  askCode: z.boolean().optional(),
  remindAfterDays: z.int().min(1).max(30).nullable().optional(),
  remindEveryDays: z.int().min(1).max(30).nullable().optional(),
  expireDays: z.int().min(1).max(365).optional(),
});

export const DocumentSendInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  about: DocumentAboutInput,
  /** What it's called on their Files and in the links; the template's name when left out. */
  name: z.string().trim().min(1).max(160).optional(),
  signers: z.array(DocumentSignerInput).min(1).max(MAX_DOCUMENT_ROLES),
  copies: z.array(DocumentCopyInput).max(MAX_DOCUMENT_COPIES).default([]),
  /** What the team filled in or changed on the Send screen, by field; the rest fill in from HandsFreeOS. */
  values: z.record(DocumentItemId, DocumentValue).default({}),
  /** This customer's copy only (answer 27a): the words typed over, in place of the template's. */
  edits: z.array(DocumentEdit).max(MAX_DOCUMENT_EDITS).optional(),
  /** The note that goes with the links; the template's when left out. */
  message: z.string().trim().max(2000).optional(),
  settings: DocumentSendSettingsInput.default({}),
  /** The estimate its fill-ins read from. */
  estimateId: uuid.optional(),
  /** The voided document this one corrects. */
  replacesDocumentId: uuid.optional(),
});
export const DocumentSendOutput = z.object({
  documentId: uuid,
  name: z.string(),
  expiresAt: isoDateTime,
  signers: z.array(
    z.object({
      signerId: uuid,
      kind: z.enum(['signer', 'copy']),
      roleKey: z.string().nullable(),
      name: z.string(),
      status: SignerStatusValue,
    }),
  ),
});

export const DocumentPrefillInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  about: DocumentAboutInput,
  estimateId: uuid.optional(),
  /** A voided or declined document to start from: its signers, fill-ins and word changes. */
  fromDocumentId: uuid.optional(),
});
export const DocumentPrefillOutput = z.object({
  templateId: uuid,
  name: z.string(),
  definition: json,
  /** What each field starts with. */
  presets: json,
  /** Who each role suggests: the customer for the first customer's role, you for a team's. */
  signers: z.array(
    z.object({
      roleKey: z.string(),
      personId: uuid.nullable(),
      userId: uuid.nullable(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      inPerson: z.boolean(),
    }),
  ),
  copies: z.array(
    z.object({ personId: uuid.nullable(), userId: uuid.nullable(), name: z.string() }),
  ),
  message: z.string(),
  source: DocumentFileOut.nullable(),
  issues: z.array(DocumentIssueOut),
});

export const DocumentRefInput = z.object({ workspaceId: uuid, documentId: uuid });
/** Sign now: the signer the team hands this device to. */
export const DocumentSignNowInput = z.object({ workspaceId: uuid, signerId: uuid });
export const DocumentSignNowOutput = z.object({
  documentId: uuid,
  signerId: uuid,
  /** Their code was checked by handing it over, when the template asks for one. */
  codeChecked: z.boolean(),
});
export const DocumentVoidInput = z.object({
  workspaceId: uuid,
  documentId: uuid,
  reason: z.string().trim().max(500).optional(),
});
export const DocumentOkOutput = z.object({ documentId: uuid, changed: z.boolean() });

// ---------- reading them ----------

export const DocumentListInput = z.object({
  workspaceId: uuid,
  status: DocumentStatusValue.optional(),
  personId: uuid.optional(),
  companyId: uuid.optional(),
  leadId: uuid.optional(),
  customRecordId: uuid.optional(),
  templateId: uuid.optional(),
  limit: z.int().min(1).max(100).default(50),
  /** The `sentAt` of the last one shown, to see older ones. */
  before: isoDateTime.optional(),
});
export const DocumentSignerSummaryOut = z.object({
  id: uuid,
  kind: z.enum(['signer', 'copy']),
  name: z.string(),
  roleLabel: z.string().nullable(),
  status: SignerStatusValue,
  position: z.int(),
  /** Signs on the team's device (Sign now): no link goes at their turn. */
  inPerson: z.boolean(),
});
export const DocumentSummaryOut = z.object({
  id: uuid,
  name: z.string(),
  status: DocumentStatusValue,
  /** Out, everyone signed, and the signed copy still being made. */
  finishing: z.boolean(),
  templateId: uuid.nullable(),
  about: DocumentAboutOut.nullable(),
  sentAt: isoDateTime,
  expiresAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  sentBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  signers: z.array(DocumentSignerSummaryOut),
});
export const DocumentListOutput = z.object({
  documents: z.array(DocumentSummaryOut),
  more: z.boolean(),
});

export const DocumentStepOut = z.object({
  id: uuid,
  kind: DocumentStepKindValue,
  at: isoDateTime,
  signerId: uuid.nullable(),
  channel: z.string().nullable(),
  ip: z.string().nullable(),
  device: z.string().nullable(),
  detail: json,
  byUserId: uuid.nullable(),
});

export const DocumentSignerOut = DocumentSignerSummaryOut.extend({
  roleKey: z.string().nullable(),
  personId: uuid.nullable(),
  userId: uuid.nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  askCode: z.boolean(),
  sentAt: isoDateTime.nullable(),
  lastSentAt: isoDateTime.nullable(),
  reminders: z.int(),
  channels: z.array(z.string()),
  openedAt: isoDateTime.nullable(),
  codeCheckedAt: isoDateTime.nullable(),
  agreedAt: isoDateTime.nullable(),
  signedAt: isoDateTime.nullable(),
  declinedAt: isoDateTime.nullable(),
  declineReason: z.string().nullable(),
  ip: z.string().nullable(),
  device: z.string().nullable(),
});

export const DocumentGetOutput = DocumentSummaryOut.extend({
  definition: json,
  /** What's filled in so far, by field, and who filled each (a signer's id; null for the team before it went). */
  values: json,
  valuesBy: z.record(z.string(), uuid.nullable()),
  message: z.string().nullable(),
  signingOrder: z.enum(DOCUMENT_ORDERS),
  remindAfterDays: z.int().nullable(),
  remindEveryDays: z.int().nullable(),
  source: DocumentFileOut.nullable(),
  signed: DocumentFileOut.nullable(),
  sourceSha256: z.string().nullable(),
  signedSha256: z.string().nullable(),
  voidedAt: isoDateTime.nullable(),
  voidReason: z.string().nullable(),
  declinedAt: isoDateTime.nullable(),
  expiredAt: isoDateTime.nullable(),
  signers: z.array(DocumentSignerOut),
  steps: z.array(DocumentStepOut),
  /** May this person void it, remind and send it again. */
  canSend: z.boolean(),
});

// ---------- the worker, for the people signing ----------

const ip = z.string().trim().max(64).nullable().default(null);
const device = z.string().trim().max(400).nullable().default(null);

export const DocumentLinkSentInput = z.object({
  workspaceId: uuid,
  signerId: uuid,
  /** How it reached them. Empty: it couldn't. */
  channels: z.array(z.enum(['email', 'sms'])).max(2),
  /** 0: their link. 1 on: that reminder of it. The same number twice (a text that waited for quiet hours) is one. */
  reminder: z.int().min(0).max(1000).default(0),
});
export const DocumentLinkSentOutput = z.object({ signerId: uuid, changed: z.boolean() });

export const DocumentOpenInput = z.object({
  workspaceId: uuid,
  signerId: uuid,
  ip,
  device,
  /**
   * portal: from their portal, once the worker has seen it's theirs. Signing in there was a code to them, so a code
   * the template asks for is checked by it.
   */
  channel: z.enum(['page', 'portal']).default('page'),
});
export const DocumentOpenOutput = z.object({ signerId: uuid, first: z.boolean() });

export const DocumentCodeSentInput = z.object({
  workspaceId: uuid,
  signerId: uuid,
  /** The worker's keyed hash of the code; the code itself is never kept. */
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  channel: z.enum(['email', 'sms']),
});
export const DocumentCodeCheckInput = z.object({
  workspaceId: uuid,
  signerId: uuid,
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  ip,
  device,
});
export const DocumentCodeCheckOutput = z.object({ ok: z.boolean(), triesLeft: z.int() });

export const DocumentSignInput = z.object({
  workspaceId: uuid,
  signerId: uuid,
  /** "I agree to sign electronically", as they saw it. */
  agreedWording: z.string().trim().min(1).max(4000),
  values: z.record(DocumentItemId, DocumentValue),
  ip,
  device,
});
export const DocumentSignOutput = z.object({
  signerId: uuid,
  allSigned: z.boolean(),
  /** Whose turn it is now. */
  next: z.array(uuid),
});

export const DocumentDeclineInput = z.object({
  workspaceId: uuid,
  signerId: uuid,
  reason: z.string().trim().max(1000).nullable().default(null),
  ip,
  device,
});

export const DocumentFinishInput = z.object({
  workspaceId: uuid,
  documentId: uuid,
  signedFileId: uuid,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  signedSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const DocumentCopiesSentInput = z.object({
  workspaceId: uuid,
  documentId: uuid,
  sent: z
    .array(z.object({ signerId: uuid, channels: z.array(z.enum(['email', 'sms'])).max(2) }))
    .max(30),
});

export const DocumentSignerRefInput = z.object({ workspaceId: uuid, signerId: uuid });

export type DocumentSendInput = z.input<typeof DocumentSendInput>;
export type DocumentGetOutput = z.infer<typeof DocumentGetOutput>;
export type DocumentSummaryOut = z.infer<typeof DocumentSummaryOut>;
export type DocumentTemplateGetOutput = z.infer<typeof DocumentTemplateGetOutput>;
export type DocumentTemplateSummaryOut = z.infer<typeof DocumentTemplateSummaryOut>;
export type DocumentPrefillOutput = z.infer<typeof DocumentPrefillOutput>;
