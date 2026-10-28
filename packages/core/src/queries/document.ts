/**
 * Reading Documents (docs/documents.md): the templates, one template with what stops it going out, the documents
 * sent (all of them, or one customer's), one document with its signers and proof trail, and what the Send screen
 * starts with. Row security decides which documents a person sees: those about the customers they can see.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  companies,
  customRecords,
  documents,
  documentSigners,
  documentSteps,
  documentTemplates,
  leads,
  people,
} from '@hfos/db/schema';
import { userNames, uuidArray } from '../calendar/load';
import { documentTemplateIssues } from '../documents/check';
import { parseDocumentDefinition, type DocumentValue } from '../documents/definition';
import { loadFillContext, presetsFor } from '../documents/fill';
import { compareSteps } from '../documents/words';
import {
  documentGone,
  fileOf,
  loadDocument,
  loadTemplate,
  signersOf,
  valuesOf,
  type DocumentRow,
} from '../documents/load';
import { HfosError } from '../errors';
import { scopeCan } from '../kernel/execute';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import {
  DocumentGetOutput,
  DocumentListInput,
  DocumentListOutput,
  DocumentPrefillInput,
  DocumentPrefillOutput,
  DocumentRefInput,
  DocumentTemplateGetOutput,
  DocumentTemplateListInput,
  DocumentTemplateListOutput,
  DocumentTemplateRefInput,
} from '../schemas/document';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function outCounts(
  ctx: QueryContext,
  templateIds: readonly string[],
): Promise<Map<string, number>> {
  if (!templateIds.length) return new Map();
  const list = await rows<{ template_id: string; n: number }>(
    ctx.tx,
    sql`select template_id, count(*)::int as n from app.documents
        where template_id = any(${uuidArray(templateIds)}) and status = 'out' group by template_id`,
  );
  return new Map(list.map((r) => [r.template_id, Number(r.n)]));
}

export const documentTemplateList = defineQuery({
  name: 'document_template.list',
  description:
    'The business’s document templates: who signs each, how many fields, whether it’s ready to send, and how many are out for signing.',
  input: DocumentTemplateListInput,
  output: DocumentTemplateListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await ctx.tx
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.workspaceId, input.workspaceId),
          input.archived
            ? isNotNull(documentTemplates.archivedAt)
            : isNull(documentTemplates.archivedAt),
        ),
      )
      .orderBy(dsql`lower(${documentTemplates.name})`, documentTemplates.id);
    const out = await outCounts(
      ctx,
      list.map((t) => t.id),
    );
    return {
      templates: list.map((t) => {
        const d = parseDocumentDefinition(t.definition);
        return {
          id: t.id,
          name: t.name,
          pageCount: d.pages.length,
          roles: d.roles.map((r) => ({ key: r.key, label: r.label, kind: r.kind })),
          fieldCount: d.fields.length,
          hasPdf: !!t.sourceFileId,
          ready: documentTemplateIssues(d, !!t.sourceFileId).length === 0,
          documentsOut: out.get(t.id) ?? 0,
          updatedAt: t.updatedAt.toISOString(),
          archivedAt: iso(t.archivedAt),
        };
      }),
    };
  },
});

export const documentTemplateGet = defineQuery({
  name: 'document_template.get',
  description:
    'One document template: its PDF, who signs it, the fields and word changes placed on it, its settings, and what stops it going out.',
  input: DocumentTemplateRefInput,
  output: DocumentTemplateGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { row, definition } = await loadTemplate(ctx.tx, input.workspaceId, input.templateId);
    const source = await fileOf(ctx.tx, input.workspaceId, row.sourceFileId);
    const out = await outCounts(ctx, [row.id]);
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      definition: definition as unknown as Record<string, unknown>,
      source: source
        ? {
            fileId: source.id,
            name: source.name,
            bucket: source.bucket,
            objectPath: source.objectPath,
          }
        : null,
      issues: documentTemplateIssues(definition, !!source),
      documentsOut: out.get(row.id) ?? 0,
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: iso(row.archivedAt),
    };
  },
});

/** The name of the record each document is about. */
async function aboutNames(
  ctx: QueryContext,
  docs: readonly DocumentRow[],
): Promise<Map<string, string>> {
  const ids = (k: 'personId' | 'companyId' | 'leadId' | 'customRecordId') => [
    ...new Set(docs.map((d) => d[k]).filter((x): x is string => !!x)),
  ];
  const out = new Map<string, string>();
  const p = ids('personId');
  if (p.length)
    for (const r of await ctx.tx
      .select({ id: people.id, f: people.firstName, l: people.lastName, e: people.email })
      .from(people)
      .where(inArray(people.id, p)))
      out.set(r.id, [r.f, r.l].filter(Boolean).join(' ').trim() || r.e || 'Customer');
  const c = ids('companyId');
  if (c.length)
    for (const r of await ctx.tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, c)))
      out.set(r.id, r.name);
  const l = ids('leadId');
  if (l.length)
    for (const r of await ctx.tx
      .select({ id: leads.id, name: leads.title })
      .from(leads)
      .where(inArray(leads.id, l)))
      out.set(r.id, r.name);
  const rec = ids('customRecordId');
  if (rec.length)
    for (const r of await ctx.tx
      .select({ id: customRecords.id, name: customRecords.name })
      .from(customRecords)
      .where(inArray(customRecords.id, rec)))
      out.set(r.id, r.name);
  return out;
}

function aboutOf(d: DocumentRow, names: Map<string, string>) {
  const pick = d.personId
    ? ({ kind: 'person', id: d.personId } as const)
    : d.companyId
      ? ({ kind: 'company', id: d.companyId } as const)
      : d.leadId
        ? ({ kind: 'lead', id: d.leadId } as const)
        : d.customRecordId
          ? ({ kind: 'custom_record', id: d.customRecordId } as const)
          : null;
  return pick ? { ...pick, name: names.get(pick.id) ?? '' } : null;
}

export const documentList = defineQuery({
  name: 'document.list',
  description:
    'Documents sent to sign, newest first: all of them, one customer’s, company’s, lead’s or record’s, one template’s, or only those in one state (out, signed, declined, voided, out of time), with who signs each and how far they’ve got.',
  input: DocumentListInput,
  output: DocumentListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await ctx.tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, input.workspaceId),
          input.status ? eq(documents.status, input.status) : undefined,
          input.personId ? eq(documents.personId, input.personId) : undefined,
          input.companyId ? eq(documents.companyId, input.companyId) : undefined,
          input.leadId ? eq(documents.leadId, input.leadId) : undefined,
          input.customRecordId ? eq(documents.customRecordId, input.customRecordId) : undefined,
          input.templateId ? eq(documents.templateId, input.templateId) : undefined,
          input.before ? lt(documents.sentAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(documents.sentAt), desc(documents.id))
      .limit(input.limit + 1);
    const more = list.length > input.limit;
    const docs = list.slice(0, input.limit);
    if (!docs.length) return { documents: [], more: false };
    const signers = await ctx.tx
      .select()
      .from(documentSigners)
      .where(
        inArray(
          documentSigners.documentId,
          docs.map((d) => d.id),
        ),
      );
    const names = await aboutNames(ctx, docs);
    const senders = await userNames(
      ctx.tx,
      docs.map((d) => d.sentBy).filter((x): x is string => !!x),
    );
    return {
      documents: docs.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status as DocumentRow['status'] & 'out',
        finishing: d.status === 'out' && !!d.allSignedAt,
        templateId: d.templateId,
        about: aboutOf(d, names),
        sentAt: d.sentAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
        completedAt: iso(d.completedAt),
        sentBy: d.sentBy ? { id: d.sentBy, fullName: senders.get(d.sentBy) ?? '' } : null,
        signers: signers
          .filter((s) => s.documentId === d.id)
          .sort((a, b) =>
            a.kind === b.kind ? a.position - b.position : a.kind === 'signer' ? -1 : 1,
          )
          .map((s) => ({
            id: s.id,
            kind: s.kind as 'signer',
            name: s.name,
            roleLabel: s.roleLabel,
            status: s.status as 'sent',
            position: s.position,
            inPerson: s.inPerson,
          })),
      })),
      more,
    };
  },
});

export const documentGet = defineQuery({
  name: 'document.get',
  description:
    'One document sent to sign: who it’s about, who signs and how far each has got, what’s filled in, the proof trail (sent, opened, code checked, agreed, signed, from where), and the signed copy once it’s filed.',
  input: DocumentRefInput,
  output: DocumentGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { row: d, definition } = await loadDocument(
      ctx.tx,
      input.workspaceId,
      input.documentId,
    ).catch((e: unknown) => {
      if (e instanceof HfosError) throw documentGone();
      throw e;
    });
    const signers = await signersOf(ctx.tx, d.id);
    const { values, by } = await valuesOf(ctx.tx, d.id);
    const steps = (
      await ctx.tx
        .select()
        .from(documentSteps)
        .where(eq(documentSteps.documentId, d.id))
        .orderBy(documentSteps.at, documentSteps.id)
    ).sort(compareSteps);
    const names = await aboutNames(ctx, [d]);
    const senders = await userNames(ctx.tx, d.sentBy ? [d.sentBy] : []);
    const source = await fileOf(ctx.tx, input.workspaceId, d.sourceFileId);
    const signed = await fileOf(ctx.tx, input.workspaceId, d.signedFileId);
    const fileOut = (f: Awaited<ReturnType<typeof fileOf>>) =>
      f ? { fileId: f.id, name: f.name, bucket: f.bucket, objectPath: f.objectPath } : null;
    return {
      id: d.id,
      name: d.name,
      status: d.status as 'out',
      finishing: d.status === 'out' && !!d.allSignedAt,
      templateId: d.templateId,
      about: aboutOf(d, names),
      sentAt: d.sentAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      completedAt: iso(d.completedAt),
      sentBy: d.sentBy ? { id: d.sentBy, fullName: senders.get(d.sentBy) ?? '' } : null,
      definition: definition as unknown as Record<string, unknown>,
      values: values as Record<string, unknown>,
      valuesBy: by,
      message: d.message,
      signingOrder: d.signingOrder as 'order',
      remindAfterDays: d.remindAfterDays,
      remindEveryDays: d.remindEveryDays,
      source: fileOut(source),
      signed: fileOut(signed),
      sourceSha256: d.sourceSha256,
      signedSha256: d.signedSha256,
      voidedAt: iso(d.voidedAt),
      voidReason: d.voidReason,
      declinedAt: iso(d.declinedAt),
      expiredAt: iso(d.expiredAt),
      signers: signers.map((s) => ({
        id: s.id,
        kind: s.kind as 'signer',
        name: s.name,
        roleLabel: s.roleLabel,
        roleKey: s.roleKey,
        status: s.status as 'sent',
        position: s.position,
        inPerson: s.inPerson,
        personId: s.personId,
        userId: s.userId,
        email: s.email,
        phone: s.phoneE164,
        askCode: s.askCode,
        sentAt: iso(s.sentAt),
        lastSentAt: iso(s.lastSentAt),
        reminders: s.reminders,
        channels: s.sentByChannels,
        openedAt: iso(s.openedAt),
        codeCheckedAt: iso(s.codeCheckedAt),
        agreedAt: iso(s.agreedAt),
        signedAt: iso(s.signedAt),
        declinedAt: iso(s.declinedAt),
        declineReason: s.declineReason,
        ip: s.ip,
        device: s.device,
      })),
      steps: steps.map((s) => ({
        id: s.id,
        kind: s.kind as 'sent',
        at: s.at.toISOString(),
        signerId: s.signerId,
        channel: s.channel,
        ip: s.ip,
        device: s.device,
        detail: s.detail,
        byUserId: s.byUserId,
      })),
      canSend: scopeCan(ctx.scope, 'documents.send'),
    };
  },
});

export const documentPrefill = defineQuery({
  name: 'document.prefill',
  description:
    'What the Send screen starts with for one template and one customer, company, lead or record: the fill-ins from HandsFreeOS, who each role suggests, and what stops it going out. From a voided or declined document, its signers, fill-ins and word changes.',
  input: DocumentPrefillInput,
  output: DocumentPrefillOutput,
  permission: 'documents.send',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { row, definition } = await loadTemplate(ctx.tx, ws, input.templateId);
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const fill = await loadFillContext(ctx.tx, ws, input.about, {
      estimateId: input.estimateId,
      senderUserId: me,
    });
    let given: Record<string, DocumentValue> = {};
    let edits = definition.edits;
    let from: Awaited<ReturnType<typeof signersOf>> = [];
    if (input.fromDocumentId) {
      const earlier = await loadDocument(ctx.tx, ws, input.fromDocumentId);
      const { values, by } = await valuesOf(ctx.tx, earlier.row.id);
      given = {
        ...earlier.definition.presets,
        ...Object.fromEntries(Object.entries(values).filter(([id]) => by[id] === null)),
      };
      edits = earlier.definition.edits;
      from = await signersOf(ctx.tx, earlier.row.id);
    }
    const presets = presetsFor({ ...definition, edits }, fill, given);
    const firstCustomer = definition.roles.find((r) => r.kind === 'customer');
    const meName = me ? ((await userNames(ctx.tx, [me])).get(me) ?? '') : '';
    const signers = definition.roles.map((role) => {
      const before = from.find((s) => s.kind === 'signer' && s.roleKey === role.key);
      if (before)
        return {
          roleKey: role.key,
          personId: before.personId,
          userId: before.userId,
          name: before.name,
          email: before.email,
          phone: before.phoneE164,
          inPerson: before.inPerson,
        };
      if (role.kind === 'team')
        return {
          roleKey: role.key,
          personId: null,
          userId: me,
          name: meName,
          email: null,
          phone: null,
          inPerson: false,
        };
      if (role.key === firstCustomer?.key && fill.customer)
        return {
          roleKey: role.key,
          personId: fill.customer.id,
          userId: null,
          name:
            [fill.customer.firstName, fill.customer.lastName].filter(Boolean).join(' ') ||
            fill.customer.email ||
            'Customer',
          email: fill.customer.email,
          phone: fill.customer.phone,
          inPerson: false,
        };
      return {
        roleKey: role.key,
        personId: null,
        userId: null,
        name: '',
        email: null,
        phone: null,
        inPerson: false,
      };
    });
    const source = await fileOf(ctx.tx, ws, row.sourceFileId);
    return {
      templateId: row.id,
      name: row.name,
      definition: { ...definition, edits } as unknown as Record<string, unknown>,
      presets: presets as Record<string, unknown>,
      signers,
      copies: from
        .filter((s) => s.kind === 'copy')
        .map((s) => ({ personId: s.personId, userId: s.userId, name: s.name })),
      message: definition.settings.message,
      source: source
        ? {
            fileId: source.id,
            name: source.name,
            bucket: source.bucket,
            objectPath: source.objectPath,
          }
        : null,
      issues: row.archivedAt
        ? [
            {
              rule: 'document_template_archived',
              message: `“${row.name}” is archived. Restore it first.`,
            },
          ]
        : documentTemplateIssues(definition, !!source),
    };
  },
});

export const documentQueries = [
  documentTemplateList,
  documentTemplateGet,
  documentList,
  documentGet,
  documentPrefill,
] as const;
