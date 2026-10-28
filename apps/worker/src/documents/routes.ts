/**
 * The signing page's server (`/d/<token>` on the web): what a signer sees, their 6-digit code, opening, signing,
 * declining and downloading the signed copy. No session: the token in the address is the whole of the permission,
 * so every answer is `no-store` with `no-referrer`, every change is a POST (mail scanners follow links), and each
 * address is held to a few tries a minute.
 *
 * Also `POST /v1/documents/link` for the team (signed in, `documents.send`): a signer's own link to copy, the same
 * one their email and text carry.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  consentWording,
  DOCUMENT_MESSAGES,
  documentCodeCheck,
  documentCodeSent,
  documentDecline,
  documentOpen,
  documentSign,
  DocumentItemId,
  DocumentValue,
  executeCommand,
  formatPhone,
  HfosError,
  loadDocument,
  signersOf,
  signersUp,
  valuesOf,
  workspaceMessaging,
  type DocumentDefinition,
  type DocumentEdit,
  type DocumentPage,
  type RequestMeta,
} from '@hfos/core/server';
import { asUser, asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientIdFor, reachOf, sendEmail, sendText, wasSent } from '../booking/deliver';
import { documentCodeEmail } from '../emails/templates';
import { authenticate, header, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { publicLookOf, type PublicLook } from '../look/public';
import { systemActor, type TenantScope } from '../services';
import { newSigningCode, resolveSignerToken, signerUrlFor, signingCodeHash } from './links';

const MIN = 60_000;

interface RateRule {
  readonly max: number;
  readonly timeWindow: number;
}

/** Per address: the page 30 a minute, answers 10 a minute, codes 5 per 10 minutes. */
export const SIGNING_LIMITS = {
  read: { max: 30, timeWindow: MIN },
  act: { max: 10, timeWindow: MIN },
  code: { max: 5, timeWindow: 10 * MIN },
} as const satisfies Record<string, RateRule>;

/** A new code no sooner than this after the last one, whoever asks. */
const CODE_GAP_MS = 45_000;
/** How long the page's link to the PDF works. */
const SOURCE_URL_SECONDS = 60 * 60;

const linkNotFound = () =>
  HfosError.notFound(
    'This link doesn’t work. It may be old, or cut short. Open the newest one you were sent, or contact the business.',
  );
const staleLink = () =>
  HfosError.rule(
    'document_link_stale',
    410,
    'This link is out of date. Open the newest one you were sent.',
  );

const meta = (req: FastifyRequest): RequestMeta => ({
  correlationId: randomUUID(),
  causationId: null,
  channel: 'booking_page',
  ip: req.ip,
  userAgent: header(req, 'user-agent')?.slice(0, 300) ?? null,
});

const whereFrom = (req: FastifyRequest) => ({
  ip: req.ip?.slice(0, 64) ?? null,
  device: header(req, 'user-agent')?.slice(0, 400) ?? null,
});

/** A filled honeypot is a bot: a plain 400, nothing saved. */
function refuseHoneypot(body: unknown): void {
  const website = (body as { website?: unknown } | null)?.website;
  if (typeof website === 'string' && website.trim() !== '')
    throw HfosError.validation([], 'That didn’t go through. Refresh the page and try again.');
}

const CheckBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: 'Enter the 6 digits we sent you.' }),
});
const SignBody = z.object({
  agreed: z.literal(true, { error: 'Tick the box to agree to sign electronically.' }),
  values: z.record(DocumentItemId, DocumentValue),
  website: z.string().optional(),
});
const DeclineBody = z.object({
  reason: z.string().trim().max(1000).nullable().optional(),
  website: z.string().optional(),
});
const LinkInput = z.object({ workspaceId: z.uuid(), signerId: z.uuid() });

// ---------- what the page shows ----------

export interface SigningField {
  readonly id: string;
  readonly type: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly required: boolean;
  readonly label: string;
  readonly options: readonly string[];
  readonly fontSize: number;
  /** Theirs to fill in; the rest are shown as others filled them. */
  readonly mine: boolean;
  /** Whose it is: "Customer", "Us". */
  readonly roleLabel: string;
}

export interface SigningView {
  readonly business: {
    readonly name: string;
    readonly phone: string | null;
    readonly phoneDisplay: string | null;
    readonly look: PublicLook;
  };
  readonly document: {
    readonly name: string;
    readonly status: 'out' | 'completed' | 'declined' | 'voided' | 'expired';
    readonly message: string | null;
    readonly expiresAt: string;
    readonly allSigned: boolean;
    readonly signedCopy: boolean;
  };
  readonly signer: {
    readonly name: string;
    readonly kind: 'signer' | 'copy';
    readonly roleLabel: string | null;
    readonly status: string;
    readonly yourTurn: boolean;
    readonly askCode: boolean;
    readonly codeChecked: boolean;
    /** Where a code goes, kept partly hidden: "your phone ending in 0100". Null when it can't go anywhere. */
    readonly codeTo: string | null;
    readonly signedAt: string | null;
  };
  /** Word for word what agreeing means, and what's kept with their signature. */
  readonly consent: string;
  /** The document itself: null until their code is checked. */
  readonly content: {
    readonly pages: readonly DocumentPage[];
    readonly sourceUrl: string | null;
    readonly edits: readonly DocumentEdit[];
    readonly fields: readonly SigningField[];
    readonly values: Readonly<Record<string, DocumentValue>>;
  } | null;
}

const maskEmail = (email: string): string => {
  const [user, domain] = email.split('@');
  if (!user || !domain) return 'your email';
  return `${user.slice(0, 1)}•••@${domain}`;
};

/** Where their code goes: a text when one can reach them, else email; for the team, always email. */
async function codeRoute(
  tx: Tx,
  scope: TenantScope,
  s: {
    email: string | null;
    phoneE164: string | null;
    personId: string | null;
    userId: string | null;
  },
): Promise<{ channel: 'sms' | 'email'; to: string; shown: string } | null> {
  if (!s.userId && s.phoneE164) {
    const [p] = s.personId
      ? await rows<{ consent: 'unknown' | 'opted_in' | 'opted_out' }>(
          tx,
          sql`select sms_consent::text as consent from app.people where id = ${s.personId}`,
        )
      : [];
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      { phone: s.phoneE164, email: s.email, smsOk: true, personConsent: p?.consent ?? 'unknown' },
      { text: true, email: true },
    );
    if (reach.text === null)
      return {
        channel: 'sms',
        to: s.phoneE164,
        shown: `your phone ending in ${s.phoneE164.slice(-4)}`,
      };
  }
  return s.email ? { channel: 'email', to: s.email, shown: maskEmail(s.email) } : null;
}

const roleLabelOf = (definition: DocumentDefinition, key: string): string =>
  key === 'sender' ? 'Us' : (definition.roles.find((r) => r.key === key)?.label ?? key);

async function viewOf(
  deps: HttpDeps,
  scope: TenantScope,
  signerId: string,
  documentId: string,
): Promise<SigningView> {
  const ws = scope.workspaceId;
  const found = await asWorker(deps.httpDb, scope, async (tx) => {
    const { row, definition } = await loadDocument(tx, ws, documentId);
    const signers = await signersOf(tx, documentId);
    const signer = signers.find((s) => s.id === signerId);
    if (!signer) throw linkNotFound();
    const { values } = await valuesOf(tx, documentId);
    const m = await workspaceMessaging(tx, ws);
    const [phone] = await rows<{ e164: string }>(
      tx,
      sql`select e164 from app.phone_numbers where workspace_id = ${ws} and status = 'active' limit 1`,
    );
    const [look] = await rows<{ settings: unknown }>(
      tx,
      sql`select settings from app.workspaces where id = ${ws}`,
    );
    const [source] = row.sourceFileId
      ? await rows<{ bucket: string; object_path: string }>(
          tx,
          sql`select bucket, object_path from app.files where id = ${row.sourceFileId}`,
        )
      : [];
    const route =
      signer.askCode && !signer.codeCheckedAt ? await codeRoute(tx, scope, signer) : null;
    return { row, definition, signers, signer, values, m, phone, look, source, route };
  });
  const { row, definition, signer } = found;
  const expired = row.status === 'out' && row.expiresAt.getTime() <= Date.now();
  const status = expired ? 'expired' : (row.status as SigningView['document']['status']);
  const up = signersUp(found.signers);
  const yourTurn =
    status === 'out' && signer.kind === 'signer' && up.some((s) => s.id === signer.id);
  const locked = signer.askCode && !signer.codeCheckedAt && status === 'out';
  const role = signer.roleKey;
  const mineOpen = yourTurn && signer.status !== 'signed' && signer.status !== 'declined';

  let content: SigningView['content'] = null;
  if (!locked && (status === 'out' || status === 'completed')) {
    const values: Record<string, DocumentValue> = { ...found.values };
    // What HandsFreeOS filled in for them is theirs to change until they sign.
    if (mineOpen && role)
      for (const f of definition.fields)
        if (f.role === role && !values[f.id] && definition.presets[f.id])
          values[f.id] = definition.presets[f.id]!;
    content = {
      pages: definition.pages,
      sourceUrl: found.source
        ? await deps.store
            .signedUrl(found.source.bucket, found.source.object_path, SOURCE_URL_SECONDS)
            .catch(() => null)
        : null,
      edits: definition.edits,
      fields: definition.fields.map((f) => ({
        id: f.id,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        required: f.required,
        label: f.label,
        options: f.options,
        fontSize: f.fontSize,
        mine: mineOpen && f.role === role,
        roleLabel: roleLabelOf(definition, f.role),
      })),
      values,
    };
  }
  return {
    business: {
      name: found.m.name,
      phone: found.phone?.e164 ?? null,
      phoneDisplay: found.phone ? formatPhone(found.phone.e164) : null,
      look: publicLookOf(found.look?.settings, deps.storageUrl),
    },
    document: {
      name: row.name,
      status,
      message: row.message,
      expiresAt: row.expiresAt.toISOString(),
      allSigned: !!row.allSignedAt,
      signedCopy: status === 'completed' && !!row.signedFileId,
    },
    signer: {
      name: signer.name,
      kind: signer.kind as 'signer' | 'copy',
      roleLabel: signer.roleLabel,
      status: signer.status,
      yourTurn,
      askCode: signer.askCode,
      codeChecked: !!signer.codeCheckedAt,
      codeTo: found.route?.shown ?? null,
      signedAt: signer.signedAt?.toISOString() ?? null,
    },
    consent: consentWording(found.m.name),
    content,
  };
}

export async function registerDocumentRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = Math.max(1, Math.floor(deps.money?.limitFactor ?? deps.booking?.limitFactor ?? 1));
  const limit = (r: RateRule): RateRule => ({ max: r.max * factor, timeWindow: r.timeWindow });

  /** Checks a signer's link: 404 when it isn't one, 410 when a newer one replaced it. */
  async function linked(token: string) {
    const r = await resolveSignerToken(deps.httpDb, deps.moneyLinks, token);
    if (r.status === 'invalid') throw linkNotFound();
    if (r.status === 'stale') throw staleLink();
    return r;
  }

  // ---------- the team: a signer's link to copy ----------

  app.post('/v1/documents/link', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const input = parseBody(LinkInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'documents.send');
    // Asked as them, so a document about a customer they can't see is "not there".
    const [seen] = await asUser(deps.httpDb, actor.claims, (tx) =>
      rows<{ status: string; kind: string; doc_status: string }>(
        tx,
        sql`select s.status, s.kind, d.status as doc_status from app.document_signers s
              join app.documents d on d.id = s.document_id
            where s.id = ${input.signerId} and s.workspace_id = ${input.workspaceId}`,
      ),
    );
    if (!seen)
      throw HfosError.notFound(
        'That signer isn’t on this document anymore. Refresh the page and try again.',
      );
    if (seen.doc_status !== 'out' && seen.doc_status !== 'completed')
      throw HfosError.rule(
        'document_not_out',
        409,
        'This document isn’t out for signing anymore, so its links don’t open it. Send it again if it’s still needed.',
      );
    const url = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, (tx) =>
      signerUrlFor(tx, deps.moneyLinks, input.signerId),
    );
    if (!url)
      throw HfosError.notFound(
        'That signer isn’t on this document anymore. Refresh the page and try again.',
      );
    return { url };
  });

  // ---------- the signer ----------

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of tries from here. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    pub.addHook('onSend', async (_req, reply) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    });

    pub.get<{ Params: { token: string } }>(
      '/public/sign/:token',
      { config: { rateLimit: limit(SIGNING_LIMITS.read) } },
      async (req) => {
        const s = await linked(req.params.token);
        return viewOf(deps, s.scope, s.signerId, s.documentId);
      },
    );

    /** They opened it: a POST, since mail scanners open links. Only the first open is news. */
    pub.post<{ Params: { token: string } }>(
      '/public/sign/:token/opened',
      { config: { rateLimit: limit(SIGNING_LIMITS.act) } },
      async (req) => {
        const s = await linked(req.params.token);
        const view = await viewOf(deps, s.scope, s.signerId, s.documentId);
        if (view.content && view.document.status === 'out')
          await executeCommand(
            deps.httpDb,
            documentOpen,
            { workspaceId: s.scope.workspaceId, signerId: s.signerId, ...whereFrom(req) },
            systemActor(s.scope),
            meta(req),
          );
        return { ok: true };
      },
    );

    /** A 6-digit code, by text when one can reach them, else email (answer 11a). */
    pub.post<{ Params: { token: string } }>(
      '/public/sign/:token/code',
      { config: { rateLimit: limit(SIGNING_LIMITS.code) } },
      async (req) => {
        const s = await linked(req.params.token);
        const ws = s.scope.workspaceId;
        const found = await asWorker(deps.httpDb, s.scope, async (tx) => {
          const { row } = await loadDocument(tx, ws, s.documentId);
          const signer = (await signersOf(tx, s.documentId)).find((x) => x.id === s.signerId);
          if (!signer) throw linkNotFound();
          const m = await workspaceMessaging(tx, ws);
          return { row, signer, business: m.name, route: await codeRoute(tx, s.scope, signer) };
        });
        const { signer, route } = found;
        if (!signer.askCode || signer.codeCheckedAt) return { sent: false, to: null };
        if (found.row.status !== 'out')
          throw HfosError.rule(
            'document_not_out',
            409,
            'This document isn’t out for signing anymore.',
          );
        if (!route)
          throw HfosError.rule(
            'document_code_unreachable',
            409,
            `We have no way to send you a code. Call ${found.business} and ask them to send it again.`,
          );
        const lastAt = signer.codeExpiresAt ? signer.codeExpiresAt.getTime() - 10 * MIN : 0;
        if (Date.now() - lastAt < CODE_GAP_MS)
          throw HfosError.rule(
            'document_code_wait',
            429,
            'We just sent you a code. Give it a minute to arrive before asking for another.',
          );
        const code = newSigningCode();
        await executeCommand(
          deps.httpDb,
          documentCodeSent,
          {
            workspaceId: ws,
            signerId: s.signerId,
            codeHash: signingCodeHash(deps.moneyLinks, s.signerId, code),
            channel: route.channel,
          },
          systemActor(s.scope),
          meta(req),
        );
        const words = { business: found.business, document: found.row.name, code };
        const clientId = clientIdFor('document-code', s.signerId, code, Date.now());
        if (route.channel === 'sms') {
          const r = await sendText(
            deps,
            s.scope,
            route.to,
            DOCUMENT_MESSAGES.codeText(words),
            clientId,
            meta(req),
          );
          if (!wasSent(r))
            throw HfosError.rule(
              'document_code_failed',
              502,
              'The code didn’t go through. Try again in a minute.',
            );
        } else if (signer.userId) {
          await deps.mailer.send({ to: route.to, ...documentCodeEmail(words) });
        } else {
          const r = await sendEmail(
            deps,
            s.scope,
            route.to,
            {
              subject: DOCUMENT_MESSAGES.codeSubject(found.row.name),
              body: DOCUMENT_MESSAGES.codeEmail(words),
            },
            clientId,
            meta(req),
          );
          if (!wasSent(r))
            throw HfosError.rule(
              'document_code_failed',
              502,
              'The code didn’t go through. Try again in a minute.',
            );
        }
        return { sent: true, to: route.shown };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/sign/:token/code/check',
      { config: { rateLimit: limit(SIGNING_LIMITS.act) } },
      async (req) => {
        const body = parseBody(CheckBody, req.body ?? {});
        const s = await linked(req.params.token);
        const { output } = await executeCommand(
          deps.httpDb,
          documentCodeCheck,
          {
            workspaceId: s.scope.workspaceId,
            signerId: s.signerId,
            codeHash: signingCodeHash(deps.moneyLinks, s.signerId, body.code),
            ...whereFrom(req),
          },
          systemActor(s.scope),
          meta(req),
        );
        if (!output.ok)
          throw new HfosError(
            'rule_violation',
            400,
            output.triesLeft > 0
              ? `That code isn’t right. ${output.triesLeft === 1 ? '1 try' : `${output.triesLeft} tries`} left.`
              : 'That code doesn’t work anymore. Send a new one.',
            { triesLeft: output.triesLeft },
            output.triesLeft > 0 ? 'document_code_wrong' : 'document_code_spent',
          );
        return viewOf(deps, s.scope, s.signerId, s.documentId);
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/sign/:token/sign',
      { config: { rateLimit: limit(SIGNING_LIMITS.act) } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(SignBody, req.body ?? {});
        const s = await linked(req.params.token);
        // The wording is ours, not the page's: what's kept is what they had to have read.
        const business = await asWorker(
          deps.httpDb,
          s.scope,
          async (tx) => (await workspaceMessaging(tx, s.scope.workspaceId)).name,
        );
        await executeCommand(
          deps.httpDb,
          documentSign,
          {
            workspaceId: s.scope.workspaceId,
            signerId: s.signerId,
            agreedWording: consentWording(business),
            values: body.values,
            ...whereFrom(req),
          },
          systemActor(s.scope),
          meta(req),
        );
        return viewOf(deps, s.scope, s.signerId, s.documentId);
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/sign/:token/decline',
      { config: { rateLimit: limit(SIGNING_LIMITS.act) } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(DeclineBody, req.body ?? {});
        const s = await linked(req.params.token);
        await executeCommand(
          deps.httpDb,
          documentDecline,
          {
            workspaceId: s.scope.workspaceId,
            signerId: s.signerId,
            reason: body.reason?.trim() || null,
            ...whereFrom(req),
          },
          systemActor(s.scope),
          meta(req),
        );
        return viewOf(deps, s.scope, s.signerId, s.documentId);
      },
    );

    /** The signed copy, once everyone has signed: off to a short-lived link to the file. */
    pub.get<{ Params: { token: string } }>(
      '/public/sign/:token/download',
      { config: { rateLimit: limit(SIGNING_LIMITS.read) } },
      async (req, reply) => {
        const s = await linked(req.params.token);
        const [file] = await asWorker(deps.httpDb, s.scope, (tx) =>
          rows<{ bucket: string; object_path: string }>(
            tx,
            sql`select f.bucket, f.object_path from app.documents d join app.files f on f.id = d.signed_file_id
                where d.id = ${s.documentId} and d.status = 'completed'`,
          ),
        );
        if (!file)
          throw HfosError.rule(
            'document_not_signed',
            409,
            'The signed copy isn’t ready yet. It’s made once everyone has signed.',
          );
        const url = await deps.store.signedUrl(file.bucket, file.object_path, 300);
        return reply.redirect(url, 302);
      },
    );
  });
}
