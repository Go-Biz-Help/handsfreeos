/**
 * What happens around a document after it's sent (docs/documents.md):
 *
 * - **Links** (`document.link`): each signer's private link when it's their turn, and each reminder of it. A
 *   customer gets it by email and by text from the business's own address and number (answer 10b), through
 *   `message.send`, so it sits in their conversation; someone from the team gets an email. A text that would land
 *   in quiet hours waits for them to end, as a job of its own, so the email isn't sent twice.
 * - **Reminders and running out of time** (`documents.sweep`, hourly): the first reminder two days after a link
 *   went out, then every three, and a document still out after 30 days stops (answer 14a, the document's own
 *   numbers).
 * - **Taken back** (`document.notice`): everyone who already had a link is told it doesn't need signing.
 * - **The signed copy** (`document.finish`): once everyone has signed, the PDF with everything on it and its proof
 *   page (documents/pdf.ts), filed on the record it's about and locked for good (17a).
 * - **Copies** (`document.copies`): everyone on it gets the signed copy, attached, and a link to it.
 * - **The sender hears** (bell and push, `document`) when it's done, declined or ran out of time.
 *
 * Every message has a fixed clientId, so a retried job sends nothing twice.
 */
import { createHash } from 'node:crypto';
import {
  compareSteps,
  DOCUMENT_MESSAGES,
  DOCUMENT_PUSH,
  documentCopiesSent,
  documentExpire,
  documentFinish,
  documentLinkSent,
  executeCommand,
  fileLock,
  fileStore,
  loadDocument,
  scheduleJob,
  signersOf,
  storedFilePath,
  uuidArray,
  valuesOf,
  workspaceMessaging,
  type DocumentSignerRow,
  type DocumentValue,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  clientIdFor,
  quietEndAt,
  reachOf,
  sendEmail,
  sendText,
  wasSent,
  type Reach,
} from '../booking/deliver';
import { documentTeamEmail } from '../emails/templates';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { queuePush } from '../push/queue';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { signerUrlFor } from './links';
import { buildSignedCopy, type ProofSigner, type ProofStep } from './pdf';

export const DOCUMENT_JOBS = {
  link: 'document.link',
  notice: 'document.notice',
  finish: 'document.finish',
  copies: 'document.copies',
  sweep: 'documents.sweep',
} as const;
export const DOCUMENT_SWEEP_KEY = 'sweep:documents';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SWEEP_BATCH = 200;

const jobMeta = (jobId: string): RequestMeta => workerMeta(null, jobId);

type Channel = 'email' | 'sms';

const payloadOf = (ctx: HandlerContext): Record<string, unknown> =>
  (ctx.event.payload ?? {}) as Record<string, unknown>;
const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

async function queue(
  tx: Tx,
  scope: TenantScope,
  kind: string,
  key: string,
  payload: Record<string, unknown>,
  runAt = new Date(),
): Promise<void> {
  await scheduleJob(tx, {
    kind,
    dedupeKey: `${kind}:${key}`,
    runAt,
    payload,
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

/** A signer's link, or reminder `reminder` of it; `textOnly` is the text that waited for quiet hours. */
export const queueLink = (
  tx: Tx,
  scope: TenantScope,
  signerId: string,
  reminder: number,
  opts: { textOnly?: boolean; runAt?: Date } = {},
): Promise<void> =>
  queue(
    tx,
    scope,
    DOCUMENT_JOBS.link,
    `${signerId}:${reminder}${opts.textOnly ? ':text' : ''}`,
    { signerId, reminder, ...(opts.textOnly ? { textOnly: true } : {}) },
    opts.runAt,
  );

// ---------------------------------------------------------------------------
// Who they are, and how they can be reached
// ---------------------------------------------------------------------------

interface SignerWorld {
  readonly signer: {
    id: string;
    kind: 'signer' | 'copy';
    status: string;
    name: string;
    email: string | null;
    phone: string | null;
    person_id: string | null;
    user_id: string | null;
  };
  readonly document: {
    id: string;
    name: string;
    status: string;
    message: string | null;
    all_signed: boolean;
    signed_file_id: string | null;
  };
  readonly business: string;
  readonly sender: string | null;
  readonly url: string | null;
  /** A customer's: how they can be reached. Null for someone from the team. */
  readonly reach: Reach | null;
  /** When quiet hours end, or null when it isn't quiet hours. */
  readonly quietEnd: number | null;
}

async function signerWorld(
  tx: Tx,
  s: WorkerServices,
  scope: TenantScope,
  signerId: string,
  now: number,
): Promise<SignerWorld | null> {
  const [row] = await rows<{
    id: string;
    kind: 'signer' | 'copy';
    status: string;
    name: string;
    email: string | null;
    phone: string | null;
    person_id: string | null;
    user_id: string | null;
    document_id: string;
    document: string;
    doc_status: string;
    message: string | null;
    all_signed: boolean;
    signed_file_id: string | null;
    sender: string | null;
    consent: 'unknown' | 'opted_in' | 'opted_out' | null;
  }>(
    tx,
    sql`select s.id, s.kind, s.status, s.name, s.email, s.phone_e164 as phone, s.person_id, s.user_id,
          d.id as document_id, d.name as document, d.status as doc_status, d.message,
          d.all_signed_at is not null as all_signed, d.signed_file_id,
          u.full_name as sender, p.sms_consent::text as consent
        from app.document_signers s
          join app.documents d on d.id = s.document_id
          left join app.users u on u.id = d.sent_by
          left join app.people p on p.id = s.person_id
        where s.id = ${signerId} and s.workspace_id = ${scope.workspaceId}`,
  );
  if (!row) return null;
  const m = await workspaceMessaging(tx, scope.workspaceId);
  const customer = !row.user_id;
  return {
    signer: {
      id: row.id,
      kind: row.kind,
      status: row.status,
      name: row.name,
      email: row.email,
      phone: row.phone,
      person_id: row.person_id,
      user_id: row.user_id,
    },
    document: {
      id: row.document_id,
      name: row.document,
      status: row.doc_status,
      message: row.message,
      all_signed: row.all_signed,
      signed_file_id: row.signed_file_id,
    },
    business: m.name,
    sender: row.sender?.trim() || null,
    url: await signerUrlFor(tx, s.moneyLinks, signerId),
    // Like a money document, a document has no consent box of its own: the person's own consent decides, so a
    // text goes unless they said STOP.
    reach: customer
      ? await reachOf(
          tx,
          scope.workspaceId,
          {
            phone: row.phone,
            email: row.email,
            smsOk: true,
            personConsent: row.consent ?? 'unknown',
          },
          { text: true, email: true },
        )
      : null,
    quietEnd: quietEndAt(m.settings.quietHours, m.timezone || 'UTC', now),
  };
}

const worldOf = (ctx: JobContext, scope: TenantScope, signerId: string) =>
  asWorker(ctx.db, scope, (tx) => signerWorld(tx, ctx, scope, signerId, ctx.now));

interface Out {
  /** What went now, never counting a message that had gone already. */
  readonly sent: Channel[];
  /** A text that waits for quiet hours to end. */
  readonly textAt: number | null;
}

/**
 * A customer's message by email and by text, as `message.send` from the business. The text waits for quiet hours
 * (the caller queues it); `textOnly` is that text.
 */
async function toCustomer(
  ctx: JobContext,
  scope: TenantScope,
  w: SignerWorld,
  content: { text: string; email: { subject: string; body: string }; attach?: string | null },
  key: readonly (string | number)[],
  opts: { textOnly?: boolean } = {},
): Promise<Out> {
  const sent: Channel[] = [];
  const meta = jobMeta(ctx.job.id);
  if (!opts.textOnly && w.reach?.email === null && w.signer.email) {
    const r = await sendEmail(
      ctx,
      scope,
      w.signer.email,
      content.email,
      clientIdFor(...key, 'email'),
      meta,
      systemActor(scope),
      content.attach ? { attachmentFileIds: [content.attach] } : {},
    );
    if (wasSent(r) && !r.duplicate) sent.push('email');
    else if (!wasSent(r))
      ctx.log.info({ signerId: w.signer.id, why: r.refused }, 'a document email did not go');
  }
  let textAt: number | null = null;
  if (w.reach?.text === null && w.signer.phone) {
    if (w.quietEnd !== null) textAt = w.quietEnd;
    else {
      const r = await sendText(
        ctx,
        scope,
        w.signer.phone,
        content.text,
        clientIdFor(...key, 'sms'),
        meta,
      );
      if (wasSent(r) && !r.duplicate) sent.push('sms');
      else if (!wasSent(r))
        ctx.log.info({ signerId: w.signer.id, why: r.refused }, 'a document text did not go');
    }
  }
  return { sent, textAt };
}

// ---------------------------------------------------------------------------
// A signer's link, and its reminders
// ---------------------------------------------------------------------------

/** `document.link`: a signer's link when it's their turn, or a reminder of it. */
export const documentLinkJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const signerId = String(ctx.job.payload['signerId'] ?? '');
  const reminder = Math.max(0, Number(ctx.job.payload['reminder'] ?? 0) || 0);
  const textOnly = ctx.job.payload['textOnly'] === true;
  if (!signerId) return;
  const w = await worldOf(ctx, scope, signerId);
  if (!w || !w.url) return;
  if (w.document.status !== 'out' || w.document.all_signed) return;
  if (w.signer.kind !== 'signer' || w.signer.status === 'signed' || w.signer.status === 'declined')
    return;

  const a = { business: w.business, document: w.document.name, url: w.url };
  let sent: Channel[] = [];
  if (w.signer.user_id) {
    // Someone from the team: an email from HandsFreeOS, with their own link.
    if (!w.signer.email || textOnly) return;
    const mail = documentTeamEmail({
      kind: reminder > 0 ? 'reminder' : 'sign',
      business: w.business,
      document: w.document.name,
      from: w.sender,
      link: w.url,
    });
    await ctx.mailer.send({ to: w.signer.email, ...mail });
    sent = ['email'];
  } else {
    const content =
      reminder > 0
        ? {
            text: DOCUMENT_MESSAGES.reminderText(a),
            email: {
              subject: DOCUMENT_MESSAGES.reminderSubject(w.document.name),
              body: DOCUMENT_MESSAGES.reminderEmail(a),
            },
          }
        : {
            text: DOCUMENT_MESSAGES.linkText({ ...a, message: w.document.message }),
            email: {
              subject: DOCUMENT_MESSAGES.linkSubject(w.document.name),
              body: DOCUMENT_MESSAGES.linkEmail({
                ...a,
                message: w.document.message,
                sender: w.sender,
              }),
            },
          };
    const out = await toCustomer(ctx, scope, w, content, ['document-link', signerId, reminder], {
      textOnly,
    });
    sent = out.sent;
    if (out.textAt !== null)
      await asWorker(ctx.db, scope, (tx) =>
        queueLink(tx, scope, signerId, reminder, { textOnly: true, runAt: new Date(out.textAt!) }),
      );
    // Nothing went now, and a text is on its way later (or this was it): that one says so when it goes.
    if (!sent.length && (textOnly || out.textAt !== null)) return;
  }
  await executeCommand(
    ctx.db,
    documentLinkSent,
    { workspaceId: scope.workspaceId, signerId, channels: sent, reminder },
    systemActor(scope),
    jobMeta(ctx.job.id),
  );
};

// ---------------------------------------------------------------------------
// Taken back
// ---------------------------------------------------------------------------

/** `document.notice`: someone who had a link is told the document was taken back. */
export const documentNoticeJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const signerId = String(ctx.job.payload['signerId'] ?? '');
  const reason = str(ctx.job.payload['reason']);
  if (!signerId) return;
  const w = await worldOf(ctx, scope, signerId);
  if (!w || w.document.status !== 'voided') return;
  if (w.signer.user_id) {
    if (!w.signer.email) return;
    await ctx.mailer.send({
      to: w.signer.email,
      ...documentTeamEmail({
        kind: 'voided',
        business: w.business,
        document: w.document.name,
        from: w.sender,
        link: null,
        reason,
      }),
    });
    return;
  }
  const a = { business: w.business, document: w.document.name, reason };
  // An email says it now; a text goes too unless it's quiet hours, when it waits only if there's no email.
  const emailed = w.reach?.email === null && !!w.signer.email;
  const quiet = emailed && w.quietEnd !== null;
  const out = await toCustomer(
    ctx,
    scope,
    quiet ? { ...w, reach: { ...w.reach!, text: 'quiet_hours' } } : w,
    {
      text: DOCUMENT_MESSAGES.voidedText(a),
      email: {
        subject: DOCUMENT_MESSAGES.voidedSubject(w.document.name),
        body: DOCUMENT_MESSAGES.voidedEmail(a),
      },
    },
    ['document-voided', signerId],
  );
  if (out.textAt !== null) return { rescheduleAt: new Date(out.textAt) };
};

// ---------------------------------------------------------------------------
// The signed copy
// ---------------------------------------------------------------------------

/** The same id each time for a document's signed copy, so trying again keeps one. */
export function signedFileIdFor(documentId: string): string {
  const h = createHash('sha256').update(`document:${documentId}:signed`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Owner = { recordType: 'person' | 'company' | 'lead' | 'custom_record'; recordId: string };

const ownerOf = (d: {
  personId: string | null;
  companyId: string | null;
  leadId: string | null;
  customRecordId: string | null;
}): Owner | null =>
  d.personId
    ? { recordType: 'person', recordId: d.personId }
    : d.companyId
      ? { recordType: 'company', recordId: d.companyId }
      : d.leadId
        ? { recordType: 'lead', recordId: d.leadId }
        : d.customRecordId
          ? { recordType: 'custom_record', recordId: d.customRecordId }
          : null;

/** A name for a file that keeps to what storage and mail apps like. */
const signedName = (name: string) =>
  `${
    name
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 140) || 'Document'
  } (signed).pdf`;

/** `document.finish`: everyone signed, so the signed copy is made, filed on the record and locked. */
export const documentFinishJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const ws = scope.workspaceId;
  const documentId = String(ctx.job.payload['documentId'] ?? '');
  if (!documentId) return;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const { row, definition } = await loadDocument(tx, ws, documentId);
    if (row.status !== 'out' || !row.allSignedAt) return null;
    const owner = ownerOf(row);
    const [source] = row.sourceFileId
      ? await rows<{ bucket: string; object_path: string }>(
          tx,
          sql`select bucket, object_path from app.files where id = ${row.sourceFileId}`,
        )
      : [];
    const signers = await signersOf(tx, documentId);
    const { values, by } = await valuesOf(tx, documentId);
    const steps = await rows<{
      signer_id: string | null;
      kind: ProofStep['kind'];
      at: Date | string;
      channel: ProofStep['channel'];
      ip: string | null;
      device: string | null;
    }>(
      tx,
      sql`select signer_id, kind, at, channel, ip, device from app.document_steps
          where document_id = ${documentId} order by at, id`,
    );
    const m = await workspaceMessaging(tx, ws);
    const [sender] = row.sentBy
      ? await rows<{ full_name: string | null }>(
          tx,
          sql`select full_name from app.users where id = ${row.sentBy}`,
        )
      : [];
    const [stored] = await rows<{ id: string }>(
      tx,
      sql`select id from app.files where id = ${signedFileIdFor(documentId)} and status = 'ready'`,
    );
    return {
      row,
      definition,
      owner,
      source,
      signers,
      values,
      by,
      steps,
      m,
      sender,
      stored: !!stored,
    };
  });
  if (!found) return;
  const { row, owner, source } = found;
  if (!owner || !source) {
    ctx.log.error(
      { documentId },
      'a signed document has no record or no PDF to make its copy from',
    );
    return;
  }
  const sourceBytes = await ctx.store.download(source.bucket, source.object_path);
  const sourceSha256 = sha256(sourceBytes);
  const fileId = signedFileIdFor(documentId);
  const name = signedName(row.name);
  const path = storedFilePath(ws, owner.recordType, owner.recordId, fileId, name);

  let signedBytes: Uint8Array;
  if (found.stored) {
    // Made and filed already, on a try that stopped before it was finished: the copy stays the one filed.
    signedBytes = await ctx.store.download('attachments', path);
  } else {
    const at = (v: Date | string) => (v instanceof Date ? v : new Date(v));
    const signatureOf = (signerId: string): DocumentValue | undefined => {
      for (const [fieldId, v] of Object.entries(found.values))
        if (found.by[fieldId] === signerId && v.kind === 'signature') return v;
      return undefined;
    };
    const proofSigners: ProofSigner[] = [
      ...found.signers.filter((s) => s.kind === 'signer'),
      ...found.signers.filter((s) => s.kind === 'copy'),
    ].map((s: DocumentSignerRow) => ({
      id: s.id,
      kind: s.kind as 'signer' | 'copy',
      name: s.name,
      roleLabel: s.roleLabel,
      email: s.email,
      phone: s.phoneE164,
      agreedWording: s.agreedWording,
      steps: found.steps
        .filter((x) => x.signer_id === s.id)
        .map((x) => ({
          kind: x.kind,
          at: at(x.at),
          channel: x.channel,
          ip: x.ip,
          device: x.device,
        }))
        .sort(compareSteps),
    }));
    signedBytes = await buildSignedCopy({
      source: sourceBytes,
      definition: found.definition,
      values: found.values,
      proof: {
        documentId,
        documentName: row.name,
        business: found.m.name,
        sentBy: found.sender?.full_name?.trim() || null,
        sentAt: row.sentAt,
        completedAt: row.allSignedAt!,
        timeZone: found.m.timezone || 'UTC',
        sourceSha256,
        signers: proofSigners,
        signatures: Object.fromEntries(found.signers.map((s) => [s.id, signatureOf(s.id)])),
      },
    });
    await ctx.store.upload('attachments', path, Buffer.from(signedBytes), 'application/pdf', {
      upsert: true,
    });
  }
  const meta = jobMeta(ctx.job.id);
  const actor = systemActor(scope);
  await executeCommand(
    ctx.db,
    fileStore,
    {
      workspaceId: ws,
      id: fileId,
      recordType: owner.recordType,
      recordId: owner.recordId,
      name,
      mimeType: 'application/pdf',
      from: 'documents',
    },
    actor,
    meta,
  );
  await executeCommand(
    ctx.db,
    fileLock,
    { workspaceId: ws, fileId, reason: 'signed' },
    actor,
    meta,
  );
  await executeCommand(
    ctx.db,
    documentFinish,
    {
      workspaceId: ws,
      documentId,
      signedFileId: fileId,
      sourceSha256,
      signedSha256: sha256(signedBytes),
    },
    actor,
    meta,
  );
};

/** `document.copies`: the signed copy to everyone on it, attached, with their link to it. */
export const documentCopiesJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const documentId = String(ctx.job.payload['documentId'] ?? '');
  const textsOnly = ctx.job.payload['textsOnly'] === true;
  if (!documentId) return;
  const ids = await asWorker(ctx.db, scope, (tx) =>
    rows<{ id: string; bucket: string | null; object_path: string | null }>(
      tx,
      sql`select s.id, f.bucket, f.object_path from app.document_signers s
            join app.documents d on d.id = s.document_id
            left join app.files f on f.id = d.signed_file_id
          where s.document_id = ${documentId} and d.status = 'completed'
          order by s.position, s.created_at, s.id`,
    ),
  );
  if (!ids.length) return;
  const file = ids[0]!;
  let teamCopy: Buffer | null = null;
  const sent: { signerId: string; channels: Channel[] }[] = [];
  let textsAt: number | null = null;
  for (const { id } of ids) {
    const w = await worldOf(ctx, scope, id);
    if (!w || !w.url || !w.document.signed_file_id) continue;
    if (w.signer.user_id) {
      if (textsOnly || !w.signer.email) continue;
      if (!teamCopy && file.bucket && file.object_path)
        teamCopy = await ctx.store.download(file.bucket, file.object_path);
      await ctx.mailer.send({
        to: w.signer.email,
        ...documentTeamEmail({
          kind: 'done',
          business: w.business,
          document: w.document.name,
          from: w.sender,
          link: w.url,
        }),
        ...(teamCopy
          ? {
              attachments: [
                {
                  filename: signedName(w.document.name),
                  content: teamCopy,
                  contentType: 'application/pdf',
                },
              ],
            }
          : {}),
      });
      sent.push({ signerId: id, channels: ['email'] });
      continue;
    }
    const a = { business: w.business, document: w.document.name, url: w.url };
    const out = await toCustomer(
      ctx,
      scope,
      w,
      {
        text: DOCUMENT_MESSAGES.doneText(a),
        email: {
          subject: DOCUMENT_MESSAGES.doneSubject(w.document.name),
          body: DOCUMENT_MESSAGES.doneEmail(a),
        },
        attach: w.document.signed_file_id,
      },
      ['document-copy', id],
      { textOnly: textsOnly },
    );
    if (out.textAt !== null) textsAt = out.textAt;
    if (out.sent.length) sent.push({ signerId: id, channels: out.sent });
  }
  if (textsAt !== null && !textsOnly)
    await asWorker(ctx.db, scope, (tx) =>
      queue(
        tx,
        scope,
        DOCUMENT_JOBS.copies,
        `${documentId}:texts`,
        { documentId, textsOnly: true },
        new Date(textsAt!),
      ),
    );
  if (sent.length)
    await executeCommand(
      ctx.db,
      documentCopiesSent,
      { workspaceId: scope.workspaceId, documentId, sent },
      systemActor(scope),
      jobMeta(ctx.job.id),
    );
};

// ---------------------------------------------------------------------------
// Reminders and running out of time
// ---------------------------------------------------------------------------

/** `documents.sweep`, hourly across every business: reminders that are due, and documents out of time. */
export const documentsSweep: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ signer_id: string; workspace_id: string; organization_id: string; reminder: number }>(
      tx,
      sql`select signer_id, workspace_id, organization_id, reminder
          from private.document_reminders_due(${SWEEP_BATCH})`,
    ),
  );
  for (const d of due) {
    const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
    await asWorker(ctx.db, scope, (tx) => queueLink(tx, scope, d.signer_id, Number(d.reminder)));
  }
  const expired = await asWorker(ctx.db, {}, (tx) =>
    rows<{ document_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select document_id, workspace_id, organization_id from private.documents_expired(${SWEEP_BATCH})`,
    ),
  );
  for (const e of expired) {
    const scope = { workspaceId: e.workspace_id, organizationId: e.organization_id };
    try {
      await executeCommand(
        ctx.db,
        documentExpire,
        { workspaceId: scope.workspaceId, documentId: e.document_id },
        systemActor(scope),
        jobMeta(ctx.job.id),
      );
    } catch (err) {
      ctx.log.warn(
        { documentId: e.document_id, err: errorMessage(err) },
        'a document could not be expired',
      );
    }
  }
  const full = due.length === SWEEP_BATCH || expired.length === SWEEP_BATCH;
  return { rescheduleAt: new Date(Date.now() + (full ? 5 * MIN : HOUR)) };
};

export const documentJobs: JobMap = {
  [DOCUMENT_JOBS.link]: documentLinkJob,
  [DOCUMENT_JOBS.notice]: documentNoticeJob,
  [DOCUMENT_JOBS.finish]: documentFinishJob,
  [DOCUMENT_JOBS.copies]: documentCopiesJob,
  [DOCUMENT_JOBS.sweep]: documentsSweep,
};

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

/** document.sent and document.turn: the links of everyone whose turn it is. */
const onTurn: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  for (const signerId of idsOf(payloadOf(ctx)['signerIds']))
    await queueLink(ctx.tx, scope, signerId, 0);
};

/** document.reminder_asked: "Remind" on the document, for everyone whose turn it is. */
const onReminderAsked: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const ids = idsOf(payloadOf(ctx)['signerIds']);
  if (!ids.length) return;
  const found = await rows<{ id: string; reminders: number }>(
    ctx.tx,
    sql`select id, reminders from app.document_signers where id = any(${uuidArray(ids)})`,
  );
  for (const s of found) await queueLink(ctx.tx, scope, s.id, s.reminders + 1);
};

/** document.voided: everyone who had a link hears it doesn't need signing. */
const onVoided: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = payloadOf(ctx);
  for (const signerId of idsOf(p['signerIds']))
    await queue(ctx.tx, scope, DOCUMENT_JOBS.notice, `voided:${signerId}`, {
      signerId,
      reason: str(p['reason']),
    });
};

/** document.all_signed: the signed copy is made. */
const onAllSigned: EventHandler = async (ctx) => {
  const documentId = str(payloadOf(ctx)['documentId']);
  if (documentId)
    await queue(ctx.tx, tenantOf(ctx.scope), DOCUMENT_JOBS.finish, documentId, { documentId });
};

/** The person who sent it hears, on the bell and their phone. */
async function tellSender(
  ctx: HandlerContext,
  words: { title: string; body: string },
): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const p = payloadOf(ctx);
  const documentId = str(p['documentId']) ?? ctx.event.entityId;
  const sentBy = str(p['sentBy']);
  if (!documentId || !sentBy) return;
  await queuePush(ctx.tx, scope, {
    key: `document:${ctx.event.id}`,
    category: 'document',
    userIds: [sentBy],
    title: words.title,
    body: words.body,
    path: `/app/w/${scope.workspaceId}/documents/${documentId}`,
    refs: { documentId },
  });
}

/** document.completed: copies to everyone, and the sender hears. */
const onCompleted: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const documentId = str(p['documentId']);
  if (!documentId) return;
  await queue(ctx.tx, tenantOf(ctx.scope), DOCUMENT_JOBS.copies, documentId, { documentId });
  await tellSender(ctx, DOCUMENT_PUSH.completed(str(p['name']) ?? 'A document'));
};

const onDeclined: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  await tellSender(
    ctx,
    DOCUMENT_PUSH.declined(
      str(p['name']) ?? 'A document',
      str(p['signer']) ?? 'Someone',
      str(p['reason']),
    ),
  );
};

const onExpired: EventHandler = async (ctx) => {
  await tellSender(ctx, DOCUMENT_PUSH.expired(str(payloadOf(ctx)['name']) ?? 'A document'));
};

export const documentHandlers = {
  'document.sent': onTurn,
  'document.turn': onTurn,
  'document.reminder_asked': onReminderAsked,
  'document.voided': onVoided,
  'document.all_signed': onAllSigned,
  'document.completed': onCompleted,
  'document.declined': onDeclined,
  'document.expired': onExpired,
} as const satisfies Record<string, EventHandler>;
