import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { formatPhone, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAssistantRoutes } from '../assistant/routes';
import { ProviderError } from '../telephony/provider';
import {
  authenticate,
  parseBody,
  recordDelivery,
  requirePermission,
  verifiedTwilio,
  type HttpDeps,
} from './common';
import { registerEmailRoutes } from './email';
import { registerMailboxRoutes } from './oauth';
import { registerVoiceRoutes } from './voice';

export type { HttpDeps } from './common';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

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
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const { params } = v;
    let { workspaceId, organizationId } = v.account;
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
        url: v.url,
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
  registerVoiceRoutes(app, deps);
  registerEmailRoutes(app, deps);
  registerMailboxRoutes(app, deps);
  registerAssistantRoutes(app, deps, deps.assistant ?? null);

  app.post('/v1/telephony/available-numbers', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(AvailableNumbersInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const numbers = await deps.telephony.searchNumbers({
      numberType: input.numberType,
      ...(input.areaCode ? { areaCode: input.areaCode } : {}),
      ...(input.contains ? { contains: input.contains } : {}),
      limit: 10,
    });
    return { numbers: numbers.map((n) => ({ ...n, display: formatPhone(n.e164) })) };
  });

  return app;
}
