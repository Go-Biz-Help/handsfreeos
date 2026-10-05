/**
 * The client portal's sign-in, on its public pages (Real Estate round two, core). The web's `/c/<token>` page calls
 * these from the client's browser; nothing here needs anyone signed in to HandsFreeOS.
 *
 * - `GET /public/portal/:token`: whose portal the link is, and whether this device is signed in (its bearer in
 *   `Authorization`). A link that isn't one is a 404; one replaced by a newer link, or turned off, a 410 that says so.
 * - `POST …/code`: emails a six-digit code to the address on file (never to anything typed), three an hour.
 * - `POST …/verify`: the code typed back. The right one signs this device in: the worker makes a random bearer,
 *   keeps only its sha256, and hands the bearer to the browser once. It lasts 30 days from its last use, 90 at most.
 * - `POST …/sign-out`: signs this device out.
 * - `POST /public/portal/op/:name`: the one door for what a signed-in customer does (step 3): any operation that lists
 *   'customer' (`portal.*`, `<addon>.portal.*`), run by the kernel as them, in their business. The body is its input;
 *   the business comes from the device, never from the body. Nothing here is in the API or its OpenAPI.
 * - `POST /public/portal/uploads`: a customer adding a file (step 4). The kernel reserves its place
 *   (`portal.upload_begin`), and the browser gets a one-time link to put it there; then `portal.upload_confirm`
 *   through the door above checks what arrived.
 * - `GET /public/portal/files/:fileId`: a five-minute link to a file in their portal, if row security shows it to them.
 *
 * As the money pages do: everything that acts is a POST (mail scanners open links), every answer is `no-store` and
 * `no-referrer`, a honeypot refuses bots, and each address has its limits. Everything runs as the system actor in
 * the link's business, on the `portal` channel.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  CODE_MINUTES,
  executeCommand,
  executeQuery,
  HfosError,
  portalCheckCode,
  portalSendCode,
  portalUploadBegin,
  portalSessionEnd,
  portalSessionSeen,
  registry,
  type CustomerActor,
  type RequestMeta,
} from '@hfos/core/server';
import { asCustomer, asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { portalCodeEmail } from '../emails/templates';
import { resolvePortalToken, type PortalTokenResult } from '../portal/links';
import { systemActor, type TenantScope } from '../services';
import { header, parseBody, type HttpDeps } from './common';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface PortalLimits {
  readonly read: { readonly max: number; readonly timeWindow: number };
  readonly code: { readonly max: number; readonly timeWindow: number };
  readonly verify: { readonly max: number; readonly timeWindow: number };
  readonly op: { readonly max: number; readonly timeWindow: number };
}

/**
 * Per address: pages 60 a minute, codes 10 an hour (each link gets 3), tries 30 an hour (each code gets 5). A signed-in
 * device's operations, 120 a minute per device.
 */
export const PORTAL_LIMITS: PortalLimits = {
  read: { max: 60, timeWindow: MIN },
  code: { max: 10, timeWindow: HOUR },
  verify: { max: 30, timeWindow: HOUR },
  op: { max: 120, timeWindow: MIN },
};

const meta = (req?: FastifyRequest): RequestMeta => ({
  correlationId: randomUUID(),
  causationId: null,
  channel: 'portal',
  ...(req ? { ip: req.ip, userAgent: header(req, 'user-agent')?.slice(0, 300) ?? null } : {}),
});

const signedOut = () =>
  new HfosError(
    'unauthenticated',
    401,
    'You’re not signed in on this device. Open the link in your email to sign in.',
    undefined,
    'portal_signed_out',
  );

const OpBody = z.record(z.string(), z.unknown());
const UploadBody = z.object({
  recordId: z.string().uuid().nullable().optional(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
const DOWNLOAD_SECONDS = 300;

const customerOf = (session: PortalSession): CustomerActor => ({
  type: 'customer',
  workspaceId: session.scope.workspaceId,
  organizationId: session.scope.organizationId,
  personId: session.personId,
  sessionId: session.sessionId,
});

const notALink = () =>
  HfosError.notFound(
    'This link doesn’t work. Check that it matches the one in the email we sent you.',
  );

function refusal(
  r: Exclude<PortalTokenResult, { status: 'ok' }>,
  business: string | null,
): HfosError {
  if (r.status === 'invalid') return notALink();
  if (r.status === 'off')
    return new HfosError(
      'rule_violation',
      410,
      `${business ?? 'The business'} turned this portal off. Ask them if you need it again.`,
      undefined,
      'portal_access_off',
    );
  return new HfosError(
    'rule_violation',
    410,
    `This link was replaced by a newer one. Use the newest email from ${business ?? 'the business'}.`,
    undefined,
    'portal_link_stale',
  );
}

const Honeypot = { website: z.string().max(500).optional() };
const CodeBody = z.object({ ...Honeypot });
const VerifyBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Type the 6 digits from the email.'),
  device: z.string().trim().max(200).optional(),
  ...Honeypot,
});

function refuseHoneypot(body: { website?: string }): void {
  if (body.website && body.website.trim() !== '')
    throw HfosError.validation([], 'That didn’t go through. Refresh the page and try again.');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** The bearer the browser sent, if it looks like one of ours. */
function bearerOf(req: FastifyRequest): string | null {
  const auth = header(req, 'authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth.trim());
  return m ? m[1]! : null;
}

export interface PortalSession {
  readonly sessionId: string;
  readonly accessId: string;
  readonly personId: string;
  readonly scope: TenantScope;
}

type SessionRow = {
  session_id: string;
  access_id: string;
  workspace_id: string;
  organization_id: string;
  person_id: string;
  last_seen_at: Date | string;
};

/**
 * The signed-in device a request comes from, or null. A device used again after an hour is noted as still in use
 * (portal_session.seen), which keeps it signed in for another 30 days.
 */
export async function portalSessionOf(
  deps: HttpDeps,
  req: FastifyRequest,
): Promise<PortalSession | null> {
  const bearer = bearerOf(req);
  if (!bearer) return null;
  const [s] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<SessionRow>(tx, sql`select * from private.portal_session_lookup(${sha256(bearer)})`),
  );
  if (!s) return null;
  const scope = { workspaceId: s.workspace_id, organizationId: s.organization_id };
  if (Date.now() - new Date(s.last_seen_at).getTime() > HOUR)
    await executeCommand(
      deps.httpDb,
      portalSessionSeen,
      { workspaceId: scope.workspaceId, sessionId: s.session_id },
      systemActor(scope),
      meta(),
    );
  return { sessionId: s.session_id, accessId: s.access_id, personId: s.person_id, scope };
}

type Who = { business: string; first_name: string; email: string | null };

async function whoseLink(deps: HttpDeps, scope: TenantScope, accessId: string): Promise<Who> {
  const [w] = await asWorker(deps.httpDb, scope, (tx) =>
    rows<Who>(
      tx,
      sql`select w.name as business, p.first_name, p.email
          from app.portal_access a join app.people p on p.id = a.person_id
          join app.workspaces w on w.id = a.workspace_id
          where a.id = ${accessId}`,
    ),
  );
  if (!w) throw notALink();
  return w;
}

async function businessOf(deps: HttpDeps, scope: TenantScope): Promise<string | null> {
  const [w] = await asWorker(deps.httpDb, scope, (tx) =>
    rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${scope.workspaceId}`,
    ),
  );
  return w?.name ?? null;
}

const masked = (email: string | null) => {
  if (!email) return null;
  const [name, domain] = email.split('@');
  return `${(name ?? '').slice(0, 1)}•••@${domain ?? ''}`;
};

export async function registerPortalRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = Math.max(1, Math.floor(deps.booking?.limitFactor ?? 1));
  const limit = (r: PortalLimits[keyof PortalLimits]) => ({
    max: r.max * factor,
    timeWindow: r.timeWindow,
  });

  // A signed-in device's own limit; a request without one is held to its address.
  const perDevice = {
    ...limit(PORTAL_LIMITS.op),
    keyGenerator: (req: FastifyRequest) => {
      const b = bearerOf(req);
      return b ? `portal:${sha256(b).toString('hex')}` : `ip:${req.ip}`;
    },
  };

  async function linked(token: string) {
    const r = await resolvePortalToken(deps.httpDb, deps.portalLinks, token);
    if (r.status !== 'ok')
      throw refusal(r, r.status === 'invalid' ? null : await businessOf(deps, r.scope));
    return r;
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of tries from here. Wait a while and try again.',
          undefined,
          'rate_limited',
        ),
    });
    pub.addHook('onSend', async (_req, reply) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    });

    pub.get<{ Params: { token: string } }>(
      '/public/portal/:token',
      { config: { rateLimit: limit(PORTAL_LIMITS.read) } },
      async (req) => {
        const link = await linked(req.params.token);
        const who = await whoseLink(deps, link.scope, link.accessId);
        const session = await portalSessionOf(deps, req);
        return {
          business: { name: who.business },
          person: { firstName: who.first_name },
          sentTo: masked(who.email),
          signedIn: !!session && session.accessId === link.accessId,
        };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/portal/:token/code',
      { config: { rateLimit: limit(PORTAL_LIMITS.code) } },
      async (req) => {
        const body = parseBody(CodeBody, req.body ?? {});
        refuseHoneypot(body);
        const link = await linked(req.params.token);
        const { output } = await executeCommand(
          deps.httpDb,
          portalSendCode,
          { workspaceId: link.scope.workspaceId, accessId: link.accessId },
          systemActor(link.scope),
          meta(),
        );
        await deps.mailer.send({
          to: output.to,
          ...portalCodeEmail({
            business: output.business,
            firstName: output.firstName,
            code: output.code,
            minutes: CODE_MINUTES,
          }),
        });
        return { sentTo: output.sentTo, minutes: CODE_MINUTES };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/portal/:token/verify',
      { config: { rateLimit: limit(PORTAL_LIMITS.verify) } },
      async (req) => {
        const body = parseBody(VerifyBody, req.body ?? {});
        refuseHoneypot(body);
        const link = await linked(req.params.token);
        const bearer = randomBytes(32).toString('base64url');
        const { output } = await executeCommand(
          deps.httpDb,
          portalCheckCode,
          {
            workspaceId: link.scope.workspaceId,
            accessId: link.accessId,
            code: body.code,
            tokenHash: sha256(bearer).toString('hex'),
            device: body.device ?? null,
          },
          systemActor(link.scope),
          meta(),
        );
        return output.verified
          ? { verified: true as const, bearer, expiresAt: output.expiresAt }
          : { verified: false as const, triesLeft: output.triesLeft };
      },
    );

    pub.post<{ Params: { name: string } }>(
      '/public/portal/op/:name',
      { config: { rateLimit: perDevice } },
      async (req) => {
        const session = await portalSessionOf(deps, req);
        if (!session) throw signedOut();
        const name = req.params.name;
        const cmd = registry.command(name);
        const query = cmd ? undefined : registry.query(name);
        const op = cmd ?? query;
        if (!op?.actors?.includes('customer'))
          throw HfosError.notFound(
            'That isn’t something your portal does. Refresh the page and try again.',
          );
        const actor = customerOf(session);
        const input = {
          ...parseBody(OpBody, req.body ?? {}),
          workspaceId: session.scope.workspaceId,
        };
        if (cmd) return (await executeCommand(deps.httpDb, cmd, input, actor, meta(req))).output;
        return executeQuery(deps.httpDb, query!, input, actor, meta(req));
      },
    );

    pub.post('/public/portal/uploads', { config: { rateLimit: perDevice } }, async (req) => {
      const session = await portalSessionOf(deps, req);
      if (!session) throw signedOut();
      const body = parseBody(UploadBody, req.body ?? {});
      const { output } = await executeCommand(
        deps.httpDb,
        portalUploadBegin,
        { ...body, recordId: body.recordId ?? null, workspaceId: session.scope.workspaceId },
        customerOf(session),
        meta(req),
      );
      const uploadUrl = await deps.store.signedUploadUrl(output.bucket, output.objectPath);
      return { fileId: output.fileId, uploadUrl };
    });

    pub.get<{ Params: { fileId: string } }>(
      '/public/portal/files/:fileId',
      { config: { rateLimit: perDevice } },
      async (req) => {
        const session = await portalSessionOf(deps, req);
        if (!session) throw signedOut();
        const fileId = req.params.fileId;
        const gone = () =>
          HfosError.notFound(
            'That file isn’t in your portal any more. Refresh the page to see what is.',
          );
        if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw gone();
        // Row security, as the customer: only a file shown to them.
        const [seen] = await asCustomer(deps.httpDb, session.sessionId, (tx) =>
          rows<{ id: string }>(tx, sql`select id from app.files where id = ${fileId}::uuid`),
        );
        if (!seen) throw gone();
        const [f] = await asWorker(deps.httpDb, session.scope, (tx) =>
          rows<{ bucket: string; object_path: string; name: string }>(
            tx,
            sql`select bucket, object_path, name from app.files where id = ${fileId}::uuid`,
          ),
        );
        if (!f) throw gone();
        return {
          name: f.name,
          url: await deps.store.signedUrl(f.bucket, f.object_path, DOWNLOAD_SECONDS),
          expiresInSeconds: DOWNLOAD_SECONDS,
        };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/portal/:token/sign-out',
      { config: { rateLimit: limit(PORTAL_LIMITS.read) } },
      async (req) => {
        const link = await linked(req.params.token);
        const session = await portalSessionOf(deps, req);
        if (!session || session.accessId !== link.accessId) return { signedOut: false };
        const { output } = await executeCommand(
          deps.httpDb,
          portalSessionEnd,
          { workspaceId: session.scope.workspaceId, sessionId: session.sessionId },
          systemActor(session.scope),
          meta(),
        );
        return { signedOut: output.ended };
      },
    );
  });
}
