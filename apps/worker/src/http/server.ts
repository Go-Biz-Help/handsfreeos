import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import {
  bearerToken,
  formatPhone,
  HfosError,
  type HumanActor,
  type TokenVerifier,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WorkerServices } from '../services';
import { ProviderError } from '../telephony/provider';
import { verifyTwilioSignature, type WebhookParams } from '../telephony/signature';

export interface HttpDeps extends WorkerServices {
  /** A separate small pool, so the loops never starve webhooks. */
  readonly httpDb: Db;
  readonly verifyToken: TokenVerifier | null;
  readonly webOrigins: readonly string[];
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

interface WebhookAccount {
  readonly token: string;
  readonly workspaceId: string | null;
  readonly organizationId: string | null;
}

/** The token that signs webhooks for an account: the master's own, or a subaccount's (opened from its seal). */
async function webhookAccount(
  deps: HttpDeps,
  accountSid: string | undefined,
): Promise<WebhookAccount | null> {
  if (!accountSid) return null;
  if (accountSid === deps.telephony.masterAccountSid)
    return { token: deps.telephony.masterAuthToken, workspaceId: null, organizationId: null };
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string; auth_token_enc: string | null }>(
      tx,
      sql`select workspace_id, organization_id, auth_token_enc from private.telephony_account_lookup(${accountSid})`,
    ),
  );
  if (!row?.auth_token_enc) return null;
  return {
    token: deps.sealer.open(row.auth_token_enc),
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
  };
}

async function recordDelivery(
  deps: HttpDeps,
  input: {
    provider: string;
    kind: string;
    dedupeKey: string;
    accountRef: string | null;
    url: string;
    params: WebhookParams;
    workspaceId: string | null;
    organizationId: string | null;
  },
): Promise<void> {
  await asWorker(deps.httpDb, {}, (tx) =>
    rows(
      tx,
      sql`select * from private.record_webhook_delivery(${input.provider}, ${input.kind}, ${input.dedupeKey},
            ${input.accountRef}, ${input.url}, ${JSON.stringify(input.params)}::jsonb, true,
            ${input.workspaceId}, ${input.organizationId})`,
    ),
  );
}

/** Stores a verified Twilio webhook; the signature is checked against the URL providers call, never the Host header. */
function twilioWebhook(
  app: FastifyInstance,
  deps: HttpDeps,
  path: string,
  opts: {
    kind: string;
    dedupeKey: (p: Record<string, string>) => string | null;
    routeByTo?: boolean;
    reply: 'twiml' | 'empty';
  },
) {
  app.post(path, async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    const url = `${deps.publicUrl}${req.url}`;
    const account = await webhookAccount(deps, params['AccountSid']);
    if (
      !account ||
      !verifyTwilioSignature(account.token, url, params, header(req, 'x-twilio-signature'))
    ) {
      deps.log.warn(
        { path, accountSid: params['AccountSid'] },
        'rejected an unsigned or mis-signed webhook',
      );
      return reply.code(403).type('text/plain').send('Invalid signature');
    }
    let { workspaceId, organizationId } = account;
    if (opts.routeByTo && params['To']) {
      const [route] = await asWorker(deps.httpDb, {}, (tx) =>
        rows<{ workspace_id: string; organization_id: string }>(
          tx,
          sql`select workspace_id, organization_id from private.phone_route(${params['To']})`,
        ),
      );
      if (route) ({ workspace_id: workspaceId, organization_id: organizationId } = route);
    }
    const dedupeKey = opts.dedupeKey(params);
    if (dedupeKey)
      await recordDelivery(deps, {
        provider: 'twilio',
        kind: opts.kind,
        dedupeKey,
        accountRef: params['AccountSid'] ?? null,
        url,
        params,
        workspaceId,
        organizationId,
      });
    return opts.reply === 'twiml'
      ? reply.type('text/xml').send(EMPTY_TWIML)
      : reply.code(204).send();
  });
}

const AvailableNumbersInput = z.object({
  workspaceId: z.uuid(),
  numberType: z.enum(['local', 'toll_free']),
  areaCode: z
    .string()
    .regex(/^[2-9][0-9]{2}$/, 'Use a 3-digit area code.')
    .optional(),
  contains: z
    .string()
    .regex(/^[0-9]{2,7}$/, 'Use 2 to 7 digits.')
    .optional(),
});

async function authenticate(deps: HttpDeps, req: FastifyRequest): Promise<HumanActor> {
  const token = bearerToken(header(req, 'authorization'));
  if (!token || !deps.verifyToken) throw HfosError.unauthenticated();
  return deps.verifyToken(token);
}

async function requirePermission(
  deps: HttpDeps,
  userId: string,
  workspaceId: string,
  permission: string,
) {
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ ok: boolean }>(
      tx,
      sql`select private.user_has_permission(${userId}, ${workspaceId}, ${permission}) as ok`,
    ),
  );
  if (!row?.ok) throw HfosError.forbidden();
}

export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  await app.register(formbody);
  await app.register(cors, {
    origin: [...deps.webOrigins],
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type', 'x-correlation-id'],
    maxAge: 600,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HfosError) return reply.code(err.status).send(err.toBody());
    if (err instanceof ProviderError)
      return reply.code(502).send({
        error: {
          code: 'internal',
          message: 'The phone carrier did not answer. Try again in a minute.',
        },
      });
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: { code: 'validation', message: message ?? 'Bad request.' } });
    deps.log.error({ err }, 'worker http error');
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });

  app.get('/healthz', async () => ({ ok: true }));

  twilioWebhook(app, deps, '/webhooks/twilio/messaging/inbound', {
    kind: 'messaging.inbound',
    dedupeKey: (p) => p['MessageSid'] ?? null,
    routeByTo: true,
    reply: 'twiml',
  });
  twilioWebhook(app, deps, '/webhooks/twilio/messaging/status', {
    kind: 'messaging.status',
    dedupeKey: (p) =>
      p['MessageSid'] && p['MessageStatus']
        ? `${p['MessageSid']}:${p['MessageStatus']}:${p['ErrorCode'] ?? ''}`
        : null,
    reply: 'empty',
  });

  app.post('/v1/telephony/available-numbers', async (req) => {
    const actor = await authenticate(deps, req);
    const parsed = AvailableNumbersInput.safeParse(req.body);
    if (!parsed.success)
      throw HfosError.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    await requirePermission(deps, actor.userId, parsed.data.workspaceId, 'channels.manage');
    const numbers = await deps.telephony.searchNumbers({
      numberType: parsed.data.numberType,
      ...(parsed.data.areaCode ? { areaCode: parsed.data.areaCode } : {}),
      ...(parsed.data.contains ? { contains: parsed.data.contains } : {}),
      limit: 10,
    });
    return { numbers: numbers.map((n) => ({ ...n, display: formatPhone(n.e164) })) };
  });

  return app;
}
