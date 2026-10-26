/**
 * Real Estate's e-sign in the worker (round five, step 7): the one way the add-on's worker half asks DocuSign or
 * Dotloop anything, since only the worker holds the keys.
 *
 * - **Getting it ready** (`realestate.esign.requested`): the document is fetched from storage and the envelope or
 *   loop made with the business's account (`connectionFor`'s choice, kept on the envelope), then core hears where
 *   to open it (`realestate.esign.prepared`). Voided here before it was made, it's thrown away there at once.
 * - **Opening it** (the worker action `realestate.esign.open`): DocuSign's sending page, made fresh for the person,
 *   or the Dotloop loop's. `realestate.esign.check` asks again now, for when they come back from sending it.
 * - **Where it stands:** DocuSign's updates arrive at the connection's own address (unsigned, so each is read back
 *   from DocuSign), and `realestate.esign_check` looks at every open envelope every fifteen minutes beside them.
 *   Dotloop says nothing; its agent presses “It's signed” (`realestate.esign.signed_reported`).
 * - **Done:** the signed copy (and DocuSign's certificate) are stored on the deal (core's `file.store`) and core
 *   files them as locked documents (`realestate.esign.completed`).
 * - **Voided** here, it's voided at DocuSign; a failure to is kept as words on the envelope, saying to void it there.
 *
 * With the stand-ins (ADDON_CONNECTORS=fake) nothing leaves the worker (./standin.ts).
 */
import { createHash } from 'node:crypto';
import { esignCompleted, esignPrepared, esignStatus } from '@hfos/core/addons/realestate/ops/esign';
import { ESIGN_PROVIDERS, type EsignProvider } from '@hfos/core/addons/realestate/esign';
import {
  addonConnectionTokens,
  executeCommand,
  fileStore,
  HfosError,
  storedFilePath,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { assertInWorkspace } from '../../../handlers/file-removed';
import type { JobResult } from '../../../jobs';
import {
  ConnectionRefused,
  connectionById,
  connectionWorked,
  type AddonConnection,
} from '../../connections';
import { scheduleAddonJob } from '../../queue';
import { signedInTokens, type AddonOAuthProvider } from '../../sign-ins';
import type {
  AddonEventContext,
  AddonJobContext,
  AddonScopeContext,
  AddonWorkerAction,
} from '../../types';
import { openConnectionWebhook, type AddonWebhookReceiver } from '../../webhooks';
import { createDocusign, docusignOAuth, docusignUpdates } from './docusign';
import { createDotloop, dotloopOAuth } from './dotloop';
import { createStandinEsign } from './standin';
import { EsignUnreachable, type EsignFetch, type EsignService } from './types';

export { EsignUnreachable } from './types';
export { resetStandinEsign, standinAct, standinEnvelope, type StandinAct } from './standin';

/** The connector the manifest names. */
export const ESIGN = 'esign';
export const ESIGN_CHECK = 'realestate.esign_check';
export const ESIGN_CHECK_EVERY = 15 * 60_000;
/** Open envelopes looked at in one check. */
const CHECK_BATCH = 25;
/** Tries before a service that doesn't answer is given up on, in words on the envelope. */
const TRIES = 3;

let esignFetch: EsignFetch = (url, init) => fetch(url, init);
/** Tests' own service, scripted. */
export function useEsignFetch(f: EsignFetch | null): void {
  esignFetch = f ?? ((url, init) => fetch(url, init));
}
const viaEsignFetch: EsignFetch = (url, init) => esignFetch(url, init);

/** HandsFreeOS's apps at DocuSign and Dotloop (its worker module's `oauth`). */
export const ESIGN_OAUTH: Readonly<Record<EsignProvider, AddonOAuthProvider>> = {
  docusign: docusignOAuth(viaEsignFetch),
  dotloop: dotloopOAuth(viaEsignFetch),
};

const fake = (ctx: AddonScopeContext) => ctx.addonConnect?.fake ?? true;
const serviceName = (provider: string) => ESIGN_PROVIDERS[provider as EsignProvider] ?? provider;

/** The service behind one connection, signed in now: the stand-in in development and tests. */
async function serviceFor(
  ctx: AddonScopeContext,
  connection: AddonConnection,
): Promise<{ service: EsignService; tokens: Readonly<Record<string, string>> }> {
  const provider = connection.provider as EsignProvider;
  if (fake(ctx))
    return {
      service: createStandinEsign({
        provider,
        workspaceId: ctx.scope.workspaceId,
        publicUrl: ctx.publicUrl,
      }),
      tokens: connection.secret,
    };
  const oauth = ESIGN_OAUTH[provider];
  if (!oauth) throw new EsignUnreachable('HandsFreeOS can’t use that e-signature service yet.');
  const tokens = await signedInTokens(ctx, connection, oauth);
  const accessToken = tokens['accessToken'] ?? '';
  const d = connection.details;
  if (provider === 'docusign') {
    const accountId = typeof d['accountId'] === 'string' ? d['accountId'] : '';
    const baseUri = typeof d['baseUri'] === 'string' ? d['baseUri'] : '';
    if (!accountId || !baseUri)
      throw new ConnectionRefused(
        'HandsFreeOS lost track of which DocuSign account to send from. Sign in to DocuSign again under Real Estate → Settings → Connections.',
      );
    return {
      service: createDocusign({ accessToken, accountId, baseUri, fetch: viaEsignFetch }),
      tokens,
    };
  }
  const profileId = typeof d['profileId'] === 'string' ? d['profileId'] : '';
  if (!profileId)
    throw new ConnectionRefused(
      'HandsFreeOS lost track of which Dotloop profile to use. Sign in to Dotloop again under Real Estate → Settings → Connections.',
    );
  return { service: createDotloop({ accessToken, profileId, fetch: viaEsignFetch }), tokens };
}

/**
 * The connection's own address for DocuSign's updates, made the first time and kept sealed with its tokens (only
 * its hash is kept for finding it).
 */
async function webhookUrlOf(
  ctx: AddonScopeContext,
  connection: AddonConnection,
  tokens: Readonly<Record<string, string>>,
): Promise<string> {
  if (tokens['webhookUrl']) return tokens['webhookUrl'];
  const { url } = await openConnectionWebhook(ctx, connection);
  const [row] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ token_expires_at: Date | null }>(
      tx,
      sql`select token_expires_at from app.addon_connections where id = ${connection.id}`,
    ),
  );
  await executeCommand(
    ctx.db,
    addonConnectionTokens,
    {
      workspaceId: ctx.scope.workspaceId,
      connectionId: connection.id,
      secretEnc: ctx.sealer.seal(JSON.stringify({ ...tokens, webhookUrl: url })),
      keyId: ctx.sealer.keyId,
      tokenExpiresAt: row?.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
    },
    ctx.actor,
    ctx.meta,
  );
  return url;
}

interface EnvelopeRow extends Record<string, unknown> {
  readonly id: string;
  readonly deal_record_id: string;
  readonly document_id: string;
  readonly provider: EsignProvider;
  readonly connection_id: string | null;
  readonly external_id: string | null;
  readonly open_url: string | null;
  readonly state: string;
  readonly subject: string;
  readonly message: string | null;
  readonly signers: { name: string; email: string; order: number }[];
  readonly deal_name: string;
  readonly side: 'buyer' | 'listing';
  readonly title: string;
  readonly bucket: string;
  readonly object_path: string;
  readonly file_name: string;
}

async function envelopesWhere(
  ctx: AddonScopeContext,
  where: ReturnType<typeof sql>,
  limit = 1,
): Promise<EnvelopeRow[]> {
  return asWorker(ctx.db, ctx.scope, (tx) =>
    rows<EnvelopeRow>(
      tx,
      sql`select e.id, e.deal_record_id, e.document_id, e.provider, e.connection_id, e.external_id, e.open_url,
                 e.state, e.subject, e.message, e.signers, r.name as deal_name, d.side, doc.title,
                 f.bucket, f.object_path, f.name as file_name
          from addon_realestate.esign_envelopes e
          join addon_realestate.deals d on d.workspace_id = e.workspace_id and d.record_id = e.deal_record_id
          join app.custom_records r on r.id = e.deal_record_id
          join addon_realestate.documents doc on doc.id = e.document_id
          join app.files f on f.id = doc.file_id
          where e.workspace_id = ${ctx.scope.workspaceId} and ${where}
          order by e.checked_at asc nulls first, e.created_at
          limit ${limit}`,
    ),
  );
}
const envelopeById = async (ctx: AddonScopeContext, id: string) =>
  (await envelopesWhere(ctx, sql`e.id = ${id}`))[0] ?? null;

const wordsOf = (e: unknown) =>
  (e instanceof Error ? e.message : 'It didn’t answer.').slice(0, 500);
const known = (e: unknown) => e instanceof ConnectionRefused || e instanceof EsignUnreachable;

/** Records how a call to the service went on the connection, so the business sees its health. */
async function worked(ctx: AddonScopeContext, connection: AddonConnection, e?: unknown) {
  await connectionWorked(
    ctx,
    connection,
    e === undefined
      ? { ok: true }
      : { ok: false, refused: e instanceof ConnectionRefused, error: wordsOf(e) },
  );
}

const status = (ctx: AddonScopeContext, envelopeId: string, input: Record<string, unknown>) =>
  executeCommand(
    ctx.db,
    esignStatus,
    { workspaceId: ctx.scope.workspaceId, envelopeId, ...input },
    ctx.actor,
    ctx.meta,
  );

/** The connection an envelope was made with, or the words for when it's been let go. */
async function connectionOf(ctx: AddonScopeContext, row: EnvelopeRow) {
  const connection = row.connection_id ? await connectionById(ctx, row.connection_id) : null;
  return {
    connection,
    gone: `The ${serviceName(row.provider)} connection here was let go. Someone who runs the deal settings can connect it again under Real Estate → Settings → Connections; then send the document again.`,
  };
}

/** Arms the check of open DocuSign envelopes (a no-op while one is waiting). */
export async function armEsignCheck(
  ctx: AddonScopeContext,
  at = new Date(Date.now() + ESIGN_CHECK_EVERY),
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: ESIGN_CHECK,
        dedupeKey: `${ESIGN_CHECK}:${ctx.scope.workspaceId}`,
        runAt: at,
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

// ---------- getting it ready ----------

/** `realestate.esign.requested`: the envelope or loop made at the service with the document and its signers. */
export async function esignRequested(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (typeof p['envelopeId'] !== 'string') return;
  const row = await envelopeById(ctx, p['envelopeId']);
  if (!row || row.state !== 'preparing') return;
  const prepared = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      esignPrepared,
      { workspaceId: ctx.scope.workspaceId, envelopeId: row.id, ...input },
      ctx.actor,
      ctx.meta,
    );
  const { connection, gone } = await connectionOf(ctx, row);
  if (!connection) {
    await prepared({ failure: gone });
    return;
  }
  // The worker's key never reaches outside the business it's working for.
  assertInWorkspace(row.object_path, ctx.scope.workspaceId);
  const bytes = await ctx.store.download(row.bucket, row.object_path);
  let service: EsignService;
  let made: { externalId: string; openUrl: string | null };
  try {
    const signedIn = await serviceFor(ctx, connection);
    service = signedIn.service;
    const webhookUrl =
      service.provider === 'docusign' ? await webhookUrlOf(ctx, connection, signedIn.tokens) : null;
    made = await service.prepare(
      {
        subject: row.subject,
        message: row.message,
        signers: row.signers,
        document: { name: row.file_name, bytes },
        webhookUrl,
        deal: { name: row.deal_name, side: row.side },
      },
      AbortSignal.timeout(120_000),
    );
    await worked(ctx, connection);
  } catch (e) {
    if (!known(e)) throw e;
    await worked(ctx, connection, e);
    // A service that didn't answer is asked again; a sign-in turned down says so now.
    if (e instanceof EsignUnreachable && ctx.attempt < TRIES) throw e;
    await prepared({ failure: wordsOf(e) });
    return;
  }
  const { output } = await prepared({
    externalId: made.externalId,
    ...(made.openUrl ? { openUrl: made.openUrl } : {}),
  });
  // Voided here while it was being made: thrown away there too.
  if (output.state === 'voided') {
    await service
      .void(
        made.externalId,
        'Voided in HandsFreeOS before it was sent.',
        true,
        AbortSignal.timeout(60_000),
      )
      .catch((e: unknown) =>
        ctx.log.warn({ err: wordsOf(e) }, 'an e-sign draft voided early stayed'),
      );
    return;
  }
  await armEsignCheck(ctx);
}

// ---------- where it stands ----------

/** Deterministic ids for the files a signing brings back, so trying again keeps one of each. */
function fileIdFor(envelopeId: string, what: 'signed' | 'certificate'): string {
  const h = createHash('sha256').update(`${envelopeId}:${what}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Stores the signed copy (and certificate) on the deal and has core file them, locked. */
async function fileCopies(
  ctx: AddonScopeContext,
  row: EnvelopeRow,
  service: EsignService,
  completedAt: string | null,
): Promise<void> {
  const copies = await service.copies(row.external_id!, AbortSignal.timeout(120_000));
  const ws = ctx.scope.workspaceId;
  const store = async (what: 'signed' | 'certificate', bytes: Buffer, name: string) => {
    const id = fileIdFor(row.id, what);
    const path = storedFilePath(ws, 'custom_record', row.deal_record_id, id, name);
    assertInWorkspace(path, ws);
    await ctx.store.upload('attachments', path, bytes, 'application/pdf', { upsert: true });
    await executeCommand(
      ctx.db,
      fileStore,
      {
        workspaceId: ws,
        id,
        recordType: 'custom_record',
        recordId: row.deal_record_id,
        name,
        mimeType: 'application/pdf',
        from: row.provider,
      },
      ctx.actor,
      ctx.meta,
    );
    return id;
  };
  const base = row.title.replace(/\.pdf$/i, '').slice(0, 150);
  const signedFileId = await store('signed', copies.signed, `${base} (signed).pdf`);
  const certificateFileId = copies.certificate
    ? await store('certificate', copies.certificate, `${base} certificate.pdf`)
    : null;
  await executeCommand(
    ctx.db,
    esignCompleted,
    {
      workspaceId: ws,
      envelopeId: row.id,
      signedFileId,
      ...(certificateFileId ? { certificateFileId } : {}),
      ...(completedAt ? { completedAt } : {}),
    },
    ctx.actor,
    ctx.meta,
  );
}

/** Asks the service where one envelope stands and tells core; everyone signed, its copies come back. */
async function refresh(
  ctx: AddonScopeContext,
  row: EnvelopeRow,
  connection: AddonConnection,
): Promise<void> {
  const { service } = await serviceFor(ctx, connection);
  const now = await service.status(row.external_id!, AbortSignal.timeout(60_000));
  await worked(ctx, connection);
  if (!now) return;
  if (now.state === 'completed') {
    await fileCopies(ctx, row, service, now.completedAt);
    return;
  }
  await status(ctx, row.id, {
    state: now.state,
    ...(now.signers ? { signers: now.signers } : {}),
    ...(now.sentAt ? { sentAt: now.sentAt } : {}),
    failure: null,
  });
}

/** One envelope looked at now, by the person or an update; what went wrong is kept as words on it. */
async function checkOne(ctx: AddonScopeContext, row: EnvelopeRow): Promise<void> {
  if (!row.external_id || (row.state !== 'draft' && row.state !== 'sent')) return;
  const { connection, gone } = await connectionOf(ctx, row);
  if (!connection) {
    await status(ctx, row.id, { failure: gone });
    return;
  }
  try {
    await refresh(ctx, row, connection);
  } catch (e) {
    if (!known(e)) throw e;
    await worked(ctx, connection, e);
    await status(ctx, row.id, { failure: wordsOf(e) });
  }
}

/** `realestate.esign_check`: every open DocuSign envelope looked at, until none is left open. */
export async function esignCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const open = await envelopesWhere(
    ctx,
    sql`e.provider = 'docusign' and e.state in ('draft', 'sent') and e.external_id is not null`,
    CHECK_BATCH,
  );
  for (const row of open) {
    try {
      await checkOne(ctx, row);
    } catch (e) {
      ctx.log.warn({ envelopeId: row.id, err: wordsOf(e) }, 'an e-sign check failed');
    }
  }
  const [left] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from addon_realestate.esign_envelopes
          where workspace_id = ${ctx.scope.workspaceId} and provider = 'docusign'
            and state in ('draft', 'sent') and external_id is not null`,
    ),
  );
  return left?.n ? { rescheduleAt: new Date(ctx.now + ESIGN_CHECK_EVERY) } : undefined;
}

/** On again: the check is armed for whatever was left open. */
export async function armEsignCheckIfOpen(ctx: AddonScopeContext): Promise<void> {
  const [open] = await envelopesWhere(
    ctx,
    sql`e.provider = 'docusign' and e.state in ('draft', 'sent') and e.external_id is not null`,
  );
  if (open) await armEsignCheck(ctx, new Date());
}

/** DocuSign's updates at a connection's own address: which envelope to read back. */
export const DOCUSIGN_UPDATES: AddonWebhookReceiver = {
  parse: docusignUpdates,
  async handle(ctx) {
    const id = ctx.update.data['envelopeId'];
    if (typeof id !== 'string') return 'ignored';
    const [row] = await envelopesWhere(
      ctx,
      sql`e.provider = 'docusign' and e.external_id = ${id} and e.connection_id = ${ctx.connection.id}`,
    );
    if (!row || (row.state !== 'draft' && row.state !== 'sent')) return 'ignored';
    // Unsigned: what changed is read back from DocuSign, never taken from the update.
    try {
      await refresh(ctx, row, ctx.connection);
    } catch (e) {
      if (!known(e)) throw e;
      await worked(ctx, ctx.connection, e);
      // A DocuSign that didn't answer is tried again by the update's retries, then the check.
      if (e instanceof EsignUnreachable && ctx.attempt < TRIES) throw e;
      await status(ctx, row.id, { failure: wordsOf(e) });
    }
  },
};

// ---------- Dotloop's "It's signed", and voiding ----------

/** `realestate.esign.signed_reported`: the signed copy fetched from the loop and filed. */
export async function esignSignedReported(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (typeof p['envelopeId'] !== 'string') return;
  const row = await envelopeById(ctx, p['envelopeId']);
  if (!row?.external_id || (row.state !== 'draft' && row.state !== 'sent')) return;
  const { connection, gone } = await connectionOf(ctx, row);
  if (!connection) {
    await status(ctx, row.id, { failure: gone });
    return;
  }
  try {
    const { service } = await serviceFor(ctx, connection);
    await fileCopies(ctx, row, service, new Date().toISOString());
    await worked(ctx, connection);
  } catch (e) {
    if (!known(e)) throw e;
    await worked(ctx, connection, e);
    if (e instanceof EsignUnreachable && ctx.attempt < TRIES) throw e;
    await status(ctx, row.id, {
      failure:
        `${serviceName(row.provider)} didn’t hand over the signed copy: ${wordsOf(e)} Press “It’s signed” again in a few minutes.`.slice(
          0,
          500,
        ),
    });
  }
}

/** `realestate.esign.voided`: voided at DocuSign too, so nobody signs it. */
export async function esignVoided(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const envelopeId = typeof p['envelopeId'] === 'string' ? p['envelopeId'] : null;
  const externalId = typeof p['externalId'] === 'string' ? p['externalId'] : null;
  // Still being made: thrown away there once it's made (esignRequested).
  if (!envelopeId || !externalId) return;
  const row = await envelopeById(ctx, envelopeId);
  if (!row || row.provider === 'dotloop') return;
  const { connection } = await connectionOf(ctx, row);
  const failed = (words: string) =>
    status(ctx, row.id, {
      failure:
        `${serviceName(row.provider)} didn’t void it: ${words} Void it in ${serviceName(row.provider)} too, so nobody signs it.`.slice(
          0,
          500,
        ),
    });
  if (!connection) {
    await failed('the connection here was let go.');
    return;
  }
  try {
    const { service } = await serviceFor(ctx, connection);
    await service.void(
      externalId,
      typeof p['reason'] === 'string' ? p['reason'] : 'Voided in HandsFreeOS.',
      p['wasState'] === 'draft',
      AbortSignal.timeout(60_000),
    );
    await worked(ctx, connection);
  } catch (e) {
    if (!known(e)) throw e;
    await worked(ctx, connection, e);
    if (e instanceof EsignUnreachable && ctx.attempt < TRIES) throw e;
    await failed(wordsOf(e));
  }
}

// ---------- the person's own: open it, look again now ----------

const OpenInput = z.object({ envelopeId: z.uuid() });

/** The envelope for the person asking, when they're on its deal. */
async function personsEnvelope(
  ctx: AddonScopeContext & { readonly userId: string },
  envelopeId: string,
): Promise<EnvelopeRow> {
  const row = await envelopeById(ctx, envelopeId);
  const [sees] = row
    ? await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.user_sees_record(${ctx.userId}::uuid, ${row.deal_record_id}::uuid) as ok`,
        ),
      )
    : [];
  if (!row || !sees?.ok)
    throw HfosError.notFound(
      'That signing isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s documents.',
    );
  return row;
}

const asRefusal = (e: unknown): never => {
  if (e instanceof ConnectionRefused)
    throw HfosError.rule('realestate_esign_sign_in', 409, e.message);
  if (e instanceof EsignUnreachable)
    throw HfosError.rule('realestate_esign_unreachable', 503, e.message);
  throw e;
};

/** The worker's actions for e-sign (its worker module's `actions`). */
export const ESIGN_ACTIONS: Readonly<Record<string, AddonWorkerAction>> = {
  'realestate.esign.open': {
    permission: 'realestate.use',
    ai: {
      tool: 'realestate_open_signing_page',
      description:
        "The page at the e-sign service (DocuSign or dotloop) where the agent places fields and sends a document that's waiting, made fresh for them: a link to open. Nothing is sent from here.",
      autonomy: 'auto',
      keywords: ['place fields', 'docusign page', 'open signing'],
    },
    input: OpenInput,
    async run(ctx, input: z.infer<typeof OpenInput>) {
      const row = await personsEnvelope(ctx, input.envelopeId);
      if (!row.external_id || (row.state !== 'draft' && row.state !== 'sent'))
        throw HfosError.rule(
          'realestate_esign_not_open',
          409,
          `“${row.title}” isn’t waiting in ${serviceName(row.provider)} any more. Refresh to see where it stands.`,
        );
      if (row.provider === 'dotloop' && row.open_url) return { url: row.open_url };
      const { connection, gone } = await connectionOf(ctx, row);
      if (!connection) throw HfosError.rule('realestate_esign_sign_in', 409, gone);
      const back = `${ctx.webUrl}/app/w/${ctx.scope.workspaceId}/a/realestate/deals/${row.deal_record_id}/documents?esign=${row.id}`;
      try {
        const { service } = await serviceFor(ctx, connection);
        const url = await service.openUrl(
          row.external_id,
          row.state,
          back,
          AbortSignal.timeout(30_000),
        );
        await worked(ctx, connection);
        return { url };
      } catch (e) {
        if (known(e)) await worked(ctx, connection, e);
        return asRefusal(e);
      }
    },
  },
  'realestate.esign.remind': {
    permission: 'realestate.use',
    ai: {
      tool: 'realestate_remind_signers',
      description:
        "Remind everyone who hasn't signed a document that's out for signing, through the e-sign service. Asks the person first.",
      autonomy: 'confirm',
      keywords: ['remind signers', 'nudge to sign'],
    },
    input: OpenInput,
    async run(ctx, input: z.infer<typeof OpenInput>) {
      const row = await personsEnvelope(ctx, input.envelopeId);
      if (!row.external_id || row.state !== 'sent')
        throw HfosError.rule(
          'realestate_esign_not_out',
          409,
          `“${row.title}” isn’t out for signing, so there’s nobody to remind. Refresh to see where it stands.`,
        );
      const { connection, gone } = await connectionOf(ctx, row);
      if (!connection) throw HfosError.rule('realestate_esign_sign_in', 409, gone);
      try {
        const { service } = await serviceFor(ctx, connection);
        if (!service.remind)
          throw HfosError.rule(
            'realestate_esign_no_remind',
            409,
            `${serviceName(row.provider)} doesn’t take reminders from here. Remind them from the loop in ${serviceName(row.provider)}.`,
          );
        await service.remind(row.external_id, AbortSignal.timeout(30_000));
        await worked(ctx, connection);
        return { envelopeId: row.id, reminded: true };
      } catch (e) {
        if (known(e)) await worked(ctx, connection, e);
        return asRefusal(e);
      }
    },
  },
  'realestate.esign.check': {
    permission: 'realestate.use',
    ai: {
      tool: 'realestate_check_signing',
      description:
        'Ask the e-sign service where a document out for signing stands now, and bring its state up to date here.',
      autonomy: 'auto',
      keywords: ['signing status', 'has it been signed'],
    },
    input: OpenInput,
    async run(ctx, input: z.infer<typeof OpenInput>) {
      const row = await personsEnvelope(ctx, input.envelopeId);
      await checkOne(ctx, row);
      const [now] = await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ state: string }>(
          tx,
          sql`select state from addon_realestate.esign_envelopes where id = ${row.id}`,
        ),
      );
      return { envelopeId: row.id, state: now?.state ?? row.state };
    },
  },
};

/** For the stand-in's page: one envelope looked at again, by its stand-in id. */
export async function checkByExternalId(ctx: AddonScopeContext, externalId: string): Promise<void> {
  const [row] = await envelopesWhere(ctx, sql`e.external_id = ${externalId}`);
  if (row) await checkOne(ctx, row);
}
