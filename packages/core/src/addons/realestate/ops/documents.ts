/**
 * A deal's documents (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Documents"): a file already on the deal, with
 * its kind, its place in a line of versions, its status and whether it's the one that counts. Marking one signed
 * locks its file for good (core's `file.lock`, step 3): signed documents are never deleted, only replaced by a newer
 * version or voided with a reason, and they stay on the deal.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql as dsql } from 'drizzle-orm';
import { files } from '@hfos/db/schema';
import { fileLock } from '../../../commands/file';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { DOCUMENT_KINDS, type DocumentKind } from '../catalog/types';
import { realestateAddon } from '../manifest';
import {
  DocumentAddInput,
  DocumentOutput,
  DocumentSignedInput,
  DocumentUpdateInput,
  DocumentVoidInput,
} from '../schemas';
import { documents } from '../tables';
import {
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  type Deal,
} from './common';
import { documentProof, PROOF_EVENTS } from './proof-hooks';

type Doc = typeof documents.$inferSelect;

const kindLabel = (k: string) => DOCUMENT_KINDS[k as DocumentKind] ?? k;

async function loadDocument(
  ctx: CommandContext,
  documentId: string,
): Promise<{ doc: Doc; deal: Deal }> {
  const [doc] = await ctx.tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!doc)
    throw HfosError.notFound(
      'That document isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s documents.',
    );
  const deal = await loadDeal(ctx, doc.dealRecordId, { lock: true });
  requireNotArchived(deal);
  return { doc, deal };
}

const out = (d: Doc) => ({
  dealId: d.dealRecordId,
  documentId: d.id,
  version: d.version,
  status: d.status as 'draft' | 'sent' | 'signed' | 'superseded' | 'void',
  controlling: d.controlling,
});

const voided = (d: Doc) =>
  HfosError.rule(
    'realestate_document_void',
    409,
    `“${d.title}” was voided, so it doesn’t change any more. Add the document again if it’s needed.`,
  );

async function docEvent(
  ctx: CommandContext,
  type: string,
  d: Doc,
  deal: Deal,
  more: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    payload?: object;
  } = {},
) {
  return ctx.emit({
    type,
    entityType: 'custom_record',
    entityId: deal.recordId,
    payload: {
      name: deal.name,
      documentId: d.id,
      fileId: d.fileId,
      kind: d.kind,
      title: d.title,
      version: d.version,
      ...(more.payload ?? {}),
    },
    before: more.before ? { document: d.title, ...more.before } : null,
    after: { document: d.title, ...(more.after ?? {}) },
  });
}

/** Makes one document the one that counts of its kind on its deal. */
async function makeControlling(ctx: CommandContext, d: Doc) {
  await ctx.tx
    .update(documents)
    .set({ controlling: false, updatedAt: new Date() })
    .where(
      and(
        eq(documents.dealRecordId, d.dealRecordId),
        eq(documents.kind, d.kind),
        eq(documents.controlling, true),
        ne(documents.id, d.id),
      ),
    );
  await ctx.tx
    .update(documents)
    .set({ controlling: true, updatedAt: new Date() })
    .where(eq(documents.id, d.id));
}

export const documentAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.document.add',
  description:
    'Make one of a deal’s files one of its documents: its kind (purchase contract, amendment, inspection report…), its title, and the document it’s a newer version of.',
  risk: 1,
  input: DocumentAddInput,
  output: DocumentOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.document.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const [file] = await ctx.tx
      .select({ id: files.id, name: files.name })
      .from(files)
      .where(
        and(
          eq(files.id, input.fileId),
          eq(files.workspaceId, ctx.scope.workspaceId!),
          eq(files.recordType, 'custom_record'),
          eq(files.recordId, deal.recordId),
          dsql`${files.deletedAt} is null`,
        ),
      );
    if (!file)
      throw HfosError.notFound(
        `That file isn’t on ${deal.name}. Add it to the deal’s files first, then make it a document.`,
      );
    const [already] = await ctx.tx
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(eq(documents.fileId, file.id));
    if (already)
      throw HfosError.rule(
        'realestate_document_exists',
        409,
        `${file.name} is already one of the deal’s documents (“${already.title}”).`,
      );
    let lineageId: string = randomUUID();
    let version = 1;
    let supersedesId: string | null = null;
    if (input.supersedesId) {
      const [prev] = await ctx.tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, input.supersedesId), eq(documents.dealRecordId, deal.recordId)))
        .for('update');
      if (!prev)
        throw HfosError.notFound(
          'The document this replaces isn’t on this deal anymore. Refresh and pick again.',
        );
      if (prev.status === 'void') throw voided(prev);
      if (prev.kind !== input.kind)
        throw HfosError.validation([
          {
            path: 'kind',
            message: `A newer version of “${prev.title}” is a ${kindLabel(prev.kind).toLowerCase()} too.`,
          },
        ]);
      const [latest] = await ctx.tx
        .select({ version: documents.version, title: documents.title })
        .from(documents)
        .where(eq(documents.lineageId, prev.lineageId))
        .orderBy(desc(documents.version))
        .limit(1);
      if (latest && latest.version !== prev.version)
        throw HfosError.rule(
          'realestate_document_not_latest',
          409,
          `A newer version of “${prev.title}” is already here (version ${latest.version}). Add this as a version of that one.`,
        );
      lineageId = prev.lineageId;
      version = prev.version + 1;
      supersedesId = prev.id;
    }
    const [doc] = await ctx.tx
      .insert(documents)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        fileId: file.id,
        kind: input.kind,
        title: input.title ?? file.name,
        lineageId,
        version,
        supersedesId,
        status: input.status,
        createdBy: actorUserId(ctx),
      })
      .returning();
    await historyLine(ctx, deal, 'document_added', {
      after: { documentId: doc!.id, kind: input.kind, version, supersedesId },
    });
    const eventId = await docEvent(ctx, 'realestate.document.added', doc!, deal, {
      after: { kind: kindLabel(input.kind), version },
      payload: { supersedesId },
    });
    await dealLine(
      ctx,
      deal,
      version > 1
        ? `added version ${version} of the ${kindLabel(input.kind).toLowerCase()}, “${doc!.title}”`
        : `added the ${kindLabel(input.kind).toLowerCase()}, “${doc!.title}”`,
      { eventId },
    );
    return out(doc!);
  },
});

export const documentUpdate = defineAddonCommand(realestateAddon, {
  name: 'realestate.document.update',
  description:
    'Rename a deal’s document, change its kind while it’s a draft, or say it was sent for signing.',
  risk: 1,
  input: DocumentUpdateInput,
  output: DocumentOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.document.updated'],
  async handler(ctx, input) {
    const { doc, deal } = await loadDocument(ctx, input.documentId);
    if (doc.status === 'void') throw voided(doc);
    const settled = doc.status === 'signed' || doc.status === 'superseded';
    if (settled && ((input.kind && input.kind !== doc.kind) || input.status))
      throw HfosError.rule(
        'realestate_document_signed',
        409,
        `“${doc.title}” is signed, so only its title changes. Add a newer version to replace it.`,
      );
    const patch = {
      ...(input.title && input.title !== doc.title ? { title: input.title } : {}),
      ...(input.kind && input.kind !== doc.kind ? { kind: input.kind } : {}),
      ...(input.status && input.status !== doc.status ? { status: input.status } : {}),
    };
    if (!Object.keys(patch).length) return out(doc);
    if (patch.kind && doc.controlling)
      await ctx.tx.update(documents).set({ controlling: false }).where(eq(documents.id, doc.id));
    const [next] = await ctx.tx
      .update(documents)
      .set({ ...patch, updatedAt: changeMoment(ctx.meta) })
      .where(eq(documents.id, doc.id))
      .returning();
    await docEvent(ctx, 'realestate.document.updated', next!, deal, {
      before: { title: doc.title, kind: kindLabel(doc.kind), status: doc.status },
      after: { title: next!.title, kind: kindLabel(next!.kind), status: next!.status },
    });
    return out(next!);
  },
});

export const documentMarkSigned = defineAddonCommand(realestateAddon, {
  name: 'realestate.document.mark_signed',
  description:
    'Mark a deal’s document signed: its file is locked for good (never deleted or renamed), earlier versions are replaced, and it becomes the one that counts of its kind unless another does.',
  risk: 2,
  input: DocumentSignedInput,
  output: DocumentOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.document.signed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const { doc, deal } = await loadDocument(ctx, input.documentId);
    if (doc.status === 'void') throw voided(doc);
    if (doc.status === 'signed') return out(doc);
    if (doc.status === 'superseded')
      throw HfosError.rule(
        'realestate_document_not_latest',
        409,
        `A newer version of “${doc.title}” is here. Mark that one signed instead.`,
      );
    await executeCommandWithin(ctx, fileLock, {
      workspaceId: ctx.scope.workspaceId!,
      fileId: doc.fileId,
      reason: 'signed',
    });
    const at = changeMoment(ctx.meta);
    const [signed] = await ctx.tx
      .update(documents)
      .set({ status: 'signed', signedAt: at, signedBy: actorUserId(ctx), updatedAt: at })
      .where(eq(documents.id, doc.id))
      .returning();
    // Earlier versions are replaced; a signed one stays signed.
    await ctx.tx
      .update(documents)
      .set({ status: 'superseded', updatedAt: at })
      .where(
        and(
          eq(documents.lineageId, doc.lineageId),
          dsql`${documents.version} < ${doc.version}`,
          dsql`${documents.status} <> 'void'`,
        ),
      );
    const [counting] = await ctx.tx
      .select({ id: documents.id, lineageId: documents.lineageId })
      .from(documents)
      .where(
        and(
          eq(documents.dealRecordId, deal.recordId),
          eq(documents.kind, doc.kind),
          eq(documents.controlling, true),
        ),
      );
    if (!counting || counting.lineageId === doc.lineageId) await makeControlling(ctx, signed!);
    const [now] = await ctx.tx.select().from(documents).where(eq(documents.id, doc.id));
    await historyLine(ctx, deal, 'document_signed', {
      after: { documentId: doc.id, controlling: now!.controlling },
    });
    const eventId = await docEvent(ctx, 'realestate.document.signed', now!, deal, {
      before: { status: doc.status },
      after: { status: 'signed', controlling: now!.controlling },
    });
    await dealLine(ctx, deal, `marked “${doc.title}” signed`, {
      eventId,
      tone: 'success',
      body: 'Its file is locked: it stays on the deal and can only be replaced by a newer version.',
    });
    // Signed, it's proof for the duties that name its kind (the buyer agreement for X-01, an offer for B-11).
    await documentProof(ctx, deal, now!.id);
    return out(now!);
  },
});

export const documentSetControlling = defineAddonCommand(realestateAddon, {
  name: 'realestate.document.set_controlling',
  description:
    'Say which document of its kind counts on a deal (the controlling contract, say), when it isn’t the newest signed one.',
  risk: 2,
  input: DocumentSignedInput,
  output: DocumentOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.document.controlling_set'],
  async handler(ctx, input) {
    const { doc, deal } = await loadDocument(ctx, input.documentId);
    if (doc.status === 'void') throw voided(doc);
    if (doc.controlling) return out(doc);
    await makeControlling(ctx, doc);
    const [now] = await ctx.tx.select().from(documents).where(eq(documents.id, doc.id));
    await historyLine(ctx, deal, 'document_controlling', { after: { documentId: doc.id } });
    const eventId = await docEvent(ctx, 'realestate.document.controlling_set', now!, deal, {
      after: { controlling: true },
    });
    await dealLine(
      ctx,
      deal,
      `made “${doc.title}” the ${kindLabel(doc.kind).toLowerCase()} that counts`,
      { eventId },
    );
    return out(now!);
  },
});

export const documentVoid = defineAddonCommand(realestateAddon, {
  name: 'realestate.document.void',
  description:
    'Void a deal’s document with the reason (a released contract, a form sent in error). It stays on the deal, signed and locked if it was, and no longer counts.',
  risk: 2,
  input: DocumentVoidInput,
  output: DocumentOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.document.voided'],
  async handler(ctx, input) {
    const { doc, deal } = await loadDocument(ctx, input.documentId);
    if (doc.status === 'void') return out(doc);
    const at = changeMoment(ctx.meta);
    const [now] = await ctx.tx
      .update(documents)
      .set({
        status: 'void',
        controlling: false,
        voidedAt: at,
        voidedBy: actorUserId(ctx),
        voidReason: input.reason,
        updatedAt: at,
      })
      .where(eq(documents.id, doc.id))
      .returning();
    await historyLine(ctx, deal, 'document_voided', {
      before: { documentId: doc.id, status: doc.status },
      note: input.reason,
    });
    const eventId = await docEvent(ctx, 'realestate.document.voided', now!, deal, {
      before: { status: doc.status },
      after: { status: 'void' },
      payload: { reason: input.reason },
    });
    await dealLine(ctx, deal, `voided “${doc.title}”`, {
      eventId,
      body: input.reason,
      tone: 'warning',
    });
    return out(now!);
  },
});

export const documentCommands = [
  documentAdd,
  documentUpdate,
  documentMarkSigned,
  documentSetControlling,
  documentVoid,
];
