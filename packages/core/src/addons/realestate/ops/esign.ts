/**
 * E-sign (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round five, step 7): a deal's document sent for signing
 * through the brokerage's DocuSign or Dotloop, which it signs in to (Chris, 2026-10-02: both).
 *
 * - **Prepared there, sent from there.** `realestate.esign.prepare` asks the worker (it holds the keys) to make the
 *   envelope or loop with the document and its signers. The agent opens it there, places the fields and sends it;
 *   signing happens at the service. Nothing is signed on anyone's behalf.
 * - **Where it stands** comes back from the service: DocuSign's updates and a look every fifteen minutes
 *   (`realestate.esign.status`). Dotloop says nothing about signing, so its agent presses “It's signed”
 *   (`realestate.esign.mark_signed`) and the worker fetches the signed copy.
 * - **The signed copy** comes back as a newer version of the document, marked signed and locked, so it's proof for
 *   the duties that need it; DocuSign's certificate of completion comes with it, locked too
 *   (`realestate.esign.completed`).
 */
import { and, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { files } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  ESIGN_OPEN,
  ESIGN_PROVIDERS,
  ESIGN_STATES,
  esignWords,
  signersWords,
  type EsignProvider,
  type EsignSigner,
  type EsignState,
} from '../esign';
import { realestateAddon } from '../manifest';
import {
  EsignCompletedInput,
  EsignCompletedOutput,
  EsignListInput,
  EsignListOutput,
  EsignMarkSignedInput,
  EsignOutput,
  EsignPreparedInput,
  EsignPrepareInput,
  EsignStatusInput,
  EsignStatusOutput,
  EsignVoidInput,
} from '../schemas';
import { documents, esignEnvelopes } from '../tables';
import {
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  userNames,
  type Deal,
} from './common';
import { documentAdd, documentMarkSigned } from './documents';
import { PROOF_EVENTS } from './proof-hooks';

type Envelope = typeof esignEnvelopes.$inferSelect;
type Ctx = CommandContext | QueryContext;

type EsignEvent =
  | 'realestate.esign.requested'
  | 'realestate.esign.prepared'
  | 'realestate.esign.changed'
  | 'realestate.esign.signed_reported'
  | 'realestate.esign.completed'
  | 'realestate.esign.voided';

/** The e-signature services connected here, healthy or not, newest first. */
async function connectedServices(
  ctx: Ctx,
): Promise<{ id: string; provider: EsignProvider; label: string | null; failing: boolean }[]> {
  const list = await rows<{ id: string; provider: string; status: string; label: string | null }>(
    ctx.tx,
    sql`select id, provider, status, label
        from private.addon_connection_live(${ctx.scope.workspaceId!}::uuid, 'realestate', 'esign')
        where status in ('active', 'error')`,
  );
  return list
    .filter((c) => c.provider in ESIGN_PROVIDERS)
    .map((c) => ({
      id: c.id,
      provider: c.provider as EsignProvider,
      label: c.label,
      failing: c.status === 'error',
    }));
}

const noEsign = () =>
  HfosError.rule(
    'realestate_no_esign',
    409,
    'No e-signature service is connected. Someone who runs the deal settings can connect DocuSign or Dotloop under Real Estate → Settings → Connections.',
  );

async function loadEnvelope(
  ctx: CommandContext,
  envelopeId: string,
): Promise<{ envelope: Envelope; deal: Deal; title: string }> {
  const [envelope] = await ctx.tx
    .select()
    .from(esignEnvelopes)
    .where(
      and(
        eq(esignEnvelopes.id, envelopeId),
        eq(esignEnvelopes.workspaceId, ctx.scope.workspaceId!),
      ),
    )
    .for('update');
  const [doc] = envelope
    ? await ctx.tx
        .select({ title: documents.title })
        .from(documents)
        .where(eq(documents.id, envelope.documentId))
    : [];
  if (!envelope || !doc)
    throw HfosError.notFound(
      'That signing isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s documents.',
    );
  const deal = await loadDeal(ctx, envelope.dealRecordId, { lock: true });
  return { envelope, deal, title: doc.title };
}

const out = (e: Envelope) => ({
  envelopeId: e.id,
  dealId: e.dealRecordId,
  documentId: e.documentId,
  provider: e.provider,
  state: e.state,
});

const signersOf = (e: Pick<Envelope, 'signers'>) => e.signers as unknown as EsignSigner[];

async function envelopeEvent(
  ctx: CommandContext,
  type: EsignEvent,
  e: Envelope,
  deal: Deal,
  title: string,
  more: {
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly payload?: object;
    readonly broadcast?: boolean;
  } = {},
) {
  return ctx.emit({
    type,
    entityType: 'custom_record',
    entityId: deal.recordId,
    payload: {
      name: deal.name,
      envelopeId: e.id,
      documentId: e.documentId,
      title,
      provider: e.provider,
      connectionId: e.connectionId,
      externalId: e.externalId,
      ...(more.payload ?? {}),
    },
    before: more.before ?? null,
    after: { document: title, service: ESIGN_PROVIDERS[e.provider], ...(more.after ?? {}) },
    ...(more.broadcast === false ? { broadcast: false } : {}),
  });
}

// ---------- sending one ----------

export const esignPrepare = defineAddonCommand(realestateAddon, {
  name: 'realestate.esign.prepare',
  description:
    'Get one of a deal’s documents ready for signing in the brokerage’s DocuSign or Dotloop, with who signs it and in what order. The agent then opens it there, places the fields and sends it; nothing is sent to the signers yet.',
  risk: 2,
  input: EsignPrepareInput,
  output: EsignOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_prepare_for_signing',
    description:
      'Get a deal’s document ready for signing in DocuSign or Dotloop, with its signers, for the agent to send there.',
  },
  emits: ['realestate.esign.requested'],
  async handler(ctx, input) {
    const [doc] = await ctx.tx
      .select({
        id: documents.id,
        dealRecordId: documents.dealRecordId,
        title: documents.title,
        status: documents.status,
        mimeType: files.mimeType,
      })
      .from(documents)
      .innerJoin(files, eq(files.id, documents.fileId))
      .where(
        and(eq(documents.id, input.documentId), eq(documents.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!doc)
      throw HfosError.notFound(
        'That document isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s documents.',
      );
    const deal = await loadDeal(ctx, doc.dealRecordId, { lock: true });
    requireNotArchived(deal);
    if (doc.status === 'signed' || doc.status === 'superseded' || doc.status === 'void')
      throw HfosError.rule(
        'realestate_esign_settled',
        409,
        doc.status === 'void'
          ? `“${doc.title}” was voided, so it isn’t sent for signing. Add the document again if it’s needed.`
          : doc.status === 'signed'
            ? `“${doc.title}” is signed already. Add a newer version to send that one.`
            : `A newer version of “${doc.title}” is here. Send that one for signing instead.`,
      );
    if (doc.mimeType !== 'application/pdf')
      throw HfosError.rule(
        'realestate_esign_pdf',
        409,
        `Only a PDF goes for signing, and “${doc.title}” isn’t one. Save it as a PDF and add it to the deal’s documents.`,
      );
    const [open] = await ctx.tx
      .select({ provider: esignEnvelopes.provider })
      .from(esignEnvelopes)
      .where(
        and(
          eq(esignEnvelopes.documentId, doc.id),
          inArray(esignEnvelopes.state, ['preparing', ...ESIGN_OPEN]),
        ),
      );
    if (open)
      throw HfosError.rule(
        'realestate_esign_open',
        409,
        `“${doc.title}” is already with ${ESIGN_PROVIDERS[open.provider]} for signing. Open it there, or void it here to send a new one.`,
      );
    const services = await connectedServices(ctx);
    if (!services.length) throw noEsign();
    let service = services[0]!;
    if (input.provider) {
      const picked = services.find((s) => s.provider === input.provider);
      if (!picked)
        throw HfosError.rule(
          'realestate_esign_not_connected',
          409,
          `${ESIGN_PROVIDERS[input.provider]} isn’t connected here. Send it with ${ESIGN_PROVIDERS[service.provider]}, or ask someone who runs the deal settings to connect ${ESIGN_PROVIDERS[input.provider]} under Real Estate → Settings → Connections.`,
        );
      service = picked;
    } else if (new Set(services.map((s) => s.provider)).size > 1)
      throw HfosError.validation([
        { path: 'provider', message: 'Pick DocuSign or Dotloop: both are connected here.' },
      ]);
    const seen = new Set<string>();
    for (const [i, s] of input.signers.entries()) {
      const email = s.email.toLowerCase();
      if (seen.has(email))
        throw HfosError.validation([
          { path: `signers.${i}.email`, message: `${s.email} is on the list twice.` },
        ]);
      seen.add(email);
    }
    const signers: EsignSigner[] = input.signers.map((s, i) => ({
      name: s.name,
      email: s.email,
      order: s.order ?? i + 1,
      state: 'waiting',
      signedAt: null,
    }));
    const [envelope] = await ctx.tx
      .insert(esignEnvelopes)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        documentId: doc.id,
        provider: service.provider,
        connectionId: service.id,
        subject: input.subject ?? `Please sign: ${doc.title}`.slice(0, 200),
        message: input.message || null,
        signers: signers as unknown as Record<string, unknown>[],
        createdBy: actorUserId(ctx),
      })
      .returning();
    await historyLine(ctx, deal, 'esign_requested', {
      after: { envelopeId: envelope!.id, documentId: doc.id, provider: service.provider },
    });
    const eventId = await envelopeEvent(
      ctx,
      'realestate.esign.requested',
      envelope!,
      deal,
      doc.title,
      { after: { signers: signers.length } },
    );
    await dealLine(
      ctx,
      deal,
      `is getting “${doc.title}” ready for signing in ${ESIGN_PROVIDERS[service.provider]}`,
      { eventId, body: signers.map((s) => s.name).join(', ') },
    );
    return out(envelope!);
  },
});

export const esignPrepared = defineAddonCommand(realestateAddon, {
  name: 'realestate.esign.prepared',
  description:
    'Worker: the envelope or loop made at DocuSign or Dotloop, and where to open it there, or why it couldn’t be made.',
  risk: 0,
  input: EsignPreparedInput,
  output: EsignOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.esign.prepared'],
  async handler(ctx, input) {
    const { envelope, deal, title } = await loadEnvelope(ctx, input.envelopeId);
    if (envelope.state !== 'preparing') return out(envelope);
    const at = new Date();
    const failed = !!input.failure || !input.externalId;
    const [now] = await ctx.tx
      .update(esignEnvelopes)
      .set(
        failed
          ? {
              state: 'failed',
              failure: (input.failure ?? 'The service didn’t say what it made.').slice(0, 500),
              checkedAt: at,
            }
          : {
              state: 'draft',
              externalId: input.externalId,
              openUrl: input.openUrl ?? null,
              failure: null,
              preparedAt: at,
              checkedAt: at,
            },
      )
      .where(eq(esignEnvelopes.id, envelope.id))
      .returning();
    const eventId = await envelopeEvent(ctx, 'realestate.esign.prepared', now!, deal, title, {
      after: { state: now!.state },
    });
    await dealLine(
      ctx,
      deal,
      failed
        ? `couldn’t get “${title}” ready in ${ESIGN_PROVIDERS[now!.provider]}`
        : `got “${title}” ready in ${ESIGN_PROVIDERS[now!.provider]}: open it there to place the fields and send it`,
      {
        eventId,
        ...(failed ? { body: now!.failure, tone: 'warning' as const } : {}),
      },
    );
    return out(now!);
  },
});

export const esignStatus = defineAddonCommand(realestateAddon, {
  name: 'realestate.esign.status',
  description:
    'Worker: where a signing stands at DocuSign or Dotloop now (sent, declined, voided, and each signer), or why it couldn’t be asked.',
  risk: 0,
  input: EsignStatusInput,
  output: EsignStatusOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.esign.changed'],
  async handler(ctx, input) {
    const { envelope, deal, title } = await loadEnvelope(ctx, input.envelopeId);
    const at = new Date();
    const settled = !ESIGN_OPEN.includes(envelope.state);
    // Only the words of a failure change once it's settled (a void at the service that didn't go, say).
    if (settled || !input.state) {
      if (input.failure === undefined)
        return { envelopeId: envelope.id, state: envelope.state, changed: false };
      await ctx.tx
        .update(esignEnvelopes)
        .set({
          failure: input.failure,
          ...(settled ? {} : { checkedAt: at }),
          ...(!settled && input.signers ? { signers: input.signers as never } : {}),
        })
        .where(eq(esignEnvelopes.id, envelope.id));
      return { envelopeId: envelope.id, state: envelope.state, changed: false };
    }
    const state = input.state;
    const sentNow = state !== 'draft' && !envelope.sentAt;
    const [now] = await ctx.tx
      .update(esignEnvelopes)
      .set({
        state,
        checkedAt: at,
        ...(input.signers ? { signers: input.signers as never } : {}),
        ...(sentNow ? { sentAt: input.sentAt ? new Date(input.sentAt) : at } : {}),
        ...(input.failure !== undefined ? { failure: input.failure } : {}),
      })
      .where(eq(esignEnvelopes.id, envelope.id))
      .returning();
    if (state === envelope.state) return { envelopeId: now!.id, state: now!.state, changed: false };
    // Out for signing: the document says so too.
    if (sentNow)
      await ctx.tx
        .update(documents)
        .set({ status: 'sent', updatedAt: at })
        .where(and(eq(documents.id, envelope.documentId), eq(documents.status, 'draft')));
    await historyLine(ctx, deal, 'esign_changed', {
      before: { envelopeId: envelope.id, state: envelope.state },
      after: { state },
    });
    const eventId = await envelopeEvent(ctx, 'realestate.esign.changed', now!, deal, title, {
      before: { state: ESIGN_STATES[envelope.state] },
      after: { state: ESIGN_STATES[state] },
    });
    const service = ESIGN_PROVIDERS[now!.provider];
    const declinedBy = signersOf(now!).find((s) => s.state === 'declined');
    if (state === 'sent')
      await dealLine(ctx, deal, `“${title}” went out for signing in ${service}`, {
        eventId,
        body: signersWords(signersOf(now!)),
      });
    else if (state === 'declined')
      await dealLine(
        ctx,
        deal,
        `${declinedBy ? declinedBy.name : 'A signer'} declined to sign “${title}” in ${service}`,
        { eventId, tone: 'warning', body: esignWords('declined', now!.provider, null) },
      );
    else if (state === 'voided')
      await dealLine(ctx, deal, `“${title}” was voided in ${service}`, {
        eventId,
        tone: 'warning',
      });
    return { envelopeId: now!.id, state: now!.state, changed: true };
  },
});

/** The document's line now: the newest version, unless it's been voided. */
async function latestOf(ctx: CommandContext, documentId: string) {
  const [doc] = await ctx.tx.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return null;
  const [latest] = await ctx.tx
    .select({ id: documents.id, version: documents.version })
    .from(documents)
    .where(eq(documents.lineageId, doc.lineageId))
    .orderBy(desc(documents.version))
    .limit(1);
  return { doc, isLatest: latest?.id === doc.id };
}

export const esignCompleted = defineAddonCommand(realestateAddon, {
  name: 'realestate.esign.completed',
  description:
    'Worker: everyone signed. The signed copy becomes a newer version of the document, marked signed and locked; DocuSign’s certificate of completion is kept beside it, locked too.',
  risk: 0,
  input: EsignCompletedInput,
  output: EsignCompletedOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [
    'realestate.esign.completed',
    'realestate.document.added',
    'realestate.document.signed',
    'realestate.contract.read_requested',
    ...PROOF_EVENTS,
  ],
  async handler(ctx, input) {
    const { envelope, deal, title } = await loadEnvelope(ctx, input.envelopeId);
    const done = (e: Envelope) => ({
      envelopeId: e.id,
      state: e.state,
      signedDocumentId: e.signedDocumentId,
      certificateDocumentId: e.certificateDocumentId,
    });
    if (!ESIGN_OPEN.includes(envelope.state)) return done(envelope);
    const workspaceId = ctx.scope.workspaceId!;
    const source = await latestOf(ctx, envelope.documentId);
    // A newer version added meanwhile, or the document voided: the signed copy is its own document.
    const supersedes =
      source && source.isLatest && source.doc.status !== 'void' ? source.doc.id : undefined;
    const kind = source?.doc.kind ?? 'other';
    const { output: signed } = await executeCommandWithin(ctx, documentAdd, {
      workspaceId,
      dealId: deal.recordId,
      fileId: input.signedFileId,
      kind: kind as never,
      title: `${title} (signed)`.slice(0, 200),
      ...(supersedes ? { supersedesId: supersedes } : {}),
      status: 'sent',
    });
    await executeCommandWithin(ctx, documentMarkSigned, {
      workspaceId,
      documentId: signed.documentId,
    });
    let certificateId: string | null = null;
    if (input.certificateFileId) {
      const { output: cert } = await executeCommandWithin(ctx, documentAdd, {
        workspaceId,
        dealId: deal.recordId,
        fileId: input.certificateFileId,
        kind: 'other',
        title: `${ESIGN_PROVIDERS[envelope.provider]} certificate: ${title}`.slice(0, 200),
        status: 'sent',
      });
      await executeCommandWithin(ctx, documentMarkSigned, {
        workspaceId,
        documentId: cert.documentId,
      });
      certificateId = cert.documentId;
    }
    const at = input.completedAt ? new Date(input.completedAt) : new Date();
    const signers = signersOf(envelope).map((s) =>
      s.state === 'signed'
        ? s
        : { ...s, state: 'signed' as const, signedAt: s.signedAt ?? at.toISOString() },
    );
    const [now] = await ctx.tx
      .update(esignEnvelopes)
      .set({
        state: 'completed',
        completedAt: at,
        checkedAt: new Date(),
        failure: null,
        signers: signers as never,
        signedDocumentId: signed.documentId,
        certificateDocumentId: certificateId,
        ...(envelope.sentAt ? {} : { sentAt: at }),
      })
      .where(eq(esignEnvelopes.id, envelope.id))
      .returning();
    await historyLine(ctx, deal, 'esign_completed', {
      before: { envelopeId: envelope.id, state: envelope.state },
      after: {
        state: 'completed',
        signedDocumentId: signed.documentId,
        certificateDocumentId: certificateId,
      },
    });
    const eventId = await envelopeEvent(ctx, 'realestate.esign.completed', now!, deal, title, {
      before: { state: ESIGN_STATES[envelope.state] },
      after: { state: ESIGN_STATES.completed },
      payload: { signedDocumentId: signed.documentId, certificateDocumentId: certificateId },
    });
    await dealLine(ctx, deal, `“${title}” was signed in ${ESIGN_PROVIDERS[now!.provider]}`, {
      eventId,
      tone: 'success',
      body: esignWords('completed', now!.provider, null),
    });
    return done(now!);
  },
});

export const esignMarkSigned = defineAddonCommand(realestateAddon, {
  name: 'realestate.esign.mark_signed',
  description:
    'Say a document in Dotloop has been signed by everyone, so its signed copy is fetched from the loop and kept, locked. (DocuSign says so itself.)',
  risk: 2,
  input: EsignMarkSignedInput,
  output: EsignOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.esign.signed_reported'],
  async handler(ctx, input) {
    const { envelope, deal, title } = await loadEnvelope(ctx, input.envelopeId);
    requireNotArchived(deal);
    if (envelope.state === 'completed') return out(envelope);
    if (envelope.provider === 'docusign')
      throw HfosError.rule(
        'realestate_esign_says_itself',
        409,
        `DocuSign says when “${title}” is signed, and the signed copy comes back on its own. If it’s been a while, open it in DocuSign to see who hasn’t signed.`,
      );
    if (!ESIGN_OPEN.includes(envelope.state))
      throw HfosError.rule(
        'realestate_esign_settled',
        409,
        `The signing of “${title}” is ${ESIGN_STATES[envelope.state].toLowerCase()}, so it can’t be marked signed. Send it again if it’s still needed.`,
      );
    const [now] = await ctx.tx
      .update(esignEnvelopes)
      .set({ failure: null, checkedAt: new Date() })
      .where(eq(esignEnvelopes.id, envelope.id))
      .returning();
    await historyLine(ctx, deal, 'esign_signed_reported', { after: { envelopeId: envelope.id } });
    const eventId = await envelopeEvent(ctx, 'realestate.esign.signed_reported', now!, deal, title);
    await dealLine(
      ctx,
      deal,
      `said “${title}” is signed in ${ESIGN_PROVIDERS[now!.provider]}: fetching the signed copy`,
      { eventId },
    );
    return out(now!);
  },
});

export const esignVoid = defineAddonCommand(realestateAddon, {
  name: 'realestate.esign.void',
  description:
    'Stop a signing, with the reason: it’s voided at DocuSign (nobody can sign it any more) and marked voided here. A Dotloop loop is left for the agent to archive there.',
  risk: 2,
  input: EsignVoidInput,
  output: EsignOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.esign.voided'],
  async handler(ctx, input) {
    const { envelope, deal, title } = await loadEnvelope(ctx, input.envelopeId);
    if (envelope.state === 'voided') return out(envelope);
    if (envelope.state !== 'preparing' && !ESIGN_OPEN.includes(envelope.state))
      throw HfosError.rule(
        'realestate_esign_settled',
        409,
        envelope.state === 'completed'
          ? `“${title}” is signed, so it can’t be voided. Void the signed document under Documents if it no longer counts.`
          : `The signing of “${title}” has already stopped (${ESIGN_STATES[envelope.state].toLowerCase()}).`,
      );
    const [now] = await ctx.tx
      .update(esignEnvelopes)
      .set({ state: 'voided', failure: null, checkedAt: changeMoment(ctx.meta) })
      .where(eq(esignEnvelopes.id, envelope.id))
      .returning();
    await historyLine(ctx, deal, 'esign_voided', {
      before: { envelopeId: envelope.id, state: envelope.state },
      note: input.reason,
    });
    const eventId = await envelopeEvent(ctx, 'realestate.esign.voided', now!, deal, title, {
      before: { state: ESIGN_STATES[envelope.state] },
      after: { state: ESIGN_STATES.voided },
      payload: { reason: input.reason, wasState: envelope.state },
    });
    await dealLine(
      ctx,
      deal,
      `voided the signing of “${title}” in ${ESIGN_PROVIDERS[now!.provider]}`,
      { eventId, tone: 'warning', body: input.reason },
    );
    return out(now!);
  },
});

// ---------- where they stand ----------

export const esignList = defineAddonQuery(realestateAddon, {
  name: 'realestate.esign.list',
  description:
    'A deal’s documents sent for signing through DocuSign or Dotloop, newest first: where each stands, who has signed, and which services are connected here.',
  input: EsignListInput,
  output: EsignListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_signing_status',
    description: 'Where a deal’s documents sent for signing in DocuSign or Dotloop stand.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const [services, list] = await Promise.all([
      connectedServices(ctx),
      ctx.tx
        .select({ e: esignEnvelopes, title: documents.title })
        .from(esignEnvelopes)
        .innerJoin(documents, eq(documents.id, esignEnvelopes.documentId))
        .where(eq(esignEnvelopes.dealRecordId, deal.recordId))
        .orderBy(desc(esignEnvelopes.createdAt), dsql`${esignEnvelopes.id} desc`),
    ]);
    const names = await userNames(
      ctx,
      list.map((l) => l.e.createdBy),
    );
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      dealId: deal.recordId,
      connected: services.map((s) => ({
        provider: s.provider,
        label: ESIGN_PROVIDERS[s.provider],
        account: s.label,
        failing: s.failing,
      })),
      envelopes: list.map(({ e, title }) => {
        const signers = signersOf(e);
        const open = ESIGN_OPEN.includes(e.state as EsignState);
        return {
          id: e.id,
          documentId: e.documentId,
          documentTitle: title,
          provider: e.provider,
          providerLabel: ESIGN_PROVIDERS[e.provider],
          state: e.state,
          stateLabel: ESIGN_STATES[e.state],
          words: esignWords(e.state, e.provider, e.failure),
          subject: e.subject,
          message: e.message,
          signers,
          signersWords: signersWords(signers),
          failure: e.failure,
          preparedAt: iso(e.preparedAt),
          sentAt: iso(e.sentAt),
          completedAt: iso(e.completedAt),
          checkedAt: iso(e.checkedAt),
          signedDocumentId: e.signedDocumentId,
          certificateDocumentId: e.certificateDocumentId,
          createdByName: e.createdBy ? (names.get(e.createdBy) ?? null) : null,
          createdAt: e.createdAt.toISOString(),
          can: {
            open: open && !!e.externalId,
            markSigned: open && e.provider === 'dotloop',
            void: open || e.state === 'preparing',
          },
        };
      }),
    };
  },
});

export const esignCommands = [
  esignPrepare,
  esignPrepared,
  esignStatus,
  esignCompleted,
  esignMarkSigned,
  esignVoid,
];
export const esignQueries = [esignList];
