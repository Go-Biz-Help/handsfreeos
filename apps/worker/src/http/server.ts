import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import {
  checkOptInSurface,
  checkPolicy,
  checkWebsite,
  dispositionOf,
  formatPhone,
  HfosError,
  type FetchedPage,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerTeammateRoutes } from '../ai-team/routes';
import { registerAssistantRoutes } from '../assistant/routes';
import { registerKnowledgeRoutes } from '../knowledge/routes';
import { registerMoneyLinkRoutes } from '../money/link-routes';
import { registerWalletCardRoutes } from '../money/wallet-card-routes';
import { registerFakePaymentRoutes } from '../payments/fake-routes';
import { ProviderError } from '../telephony/provider';
import { registerWorkflowRoutes } from '../workflows/index';
import { registerBuilderRoutes } from '../workflows/builder-routes';
import { registerTemplateRoutes } from '../workflows/templates-routes';
import {
  authenticate,
  parseBody,
  recordDelivery,
  requirePermission,
  verifiedTwilio,
  type HttpDeps,
} from './common';
import { registerBookingRoutes } from './booking';
import { registerChatRoutes } from './chat';
import { formOrigins, registerIntakeRoutes } from './intake';
import { registerFormRoutes } from './forms';
import { registerFoundingRoutes } from './founding';
import { registerLegalRoutes } from './legal';
import { SafeFetchError } from './safe-fetch';
import { registerSiteRoutes } from './sites';
import { registerEmailRoutes } from './email';
import { registerMoneyRoutes } from './money';
import { registerMigrationRoutes } from './migrations';
import { registerOAuthRoutes } from './oauth';
import { registerTestRoutes } from './test-routes';
import { registerVoiceRoutes } from './voice';
import { registerVoiceAgentRoute } from './voice-agent';

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

/**
 * Strict on purpose. A filter this endpoint does not recognise is one a newer web app is asking for and this
 * worker has not been deployed to honour yet; stripping it quietly answers a question nobody asked, which is
 * how the city filter appeared to fail in production on 2026-09-19. Better a plain 400 than a wrong list.
 */
const AvailableNumbersInput = z
  .strictObject({
    workspaceId: z.uuid(),
    numberType: z.enum(['local', 'toll_free']),
    areaCode: z
      .string()
      .regex(/^[2-9][0-9]{2}$/, 'Use a 3-digit area code.')
      .optional(),
    // `*` stands in for any one digit, so `256***454*` pins 454 to a spot while bare `454` matches anywhere.
    contains: z
      .string()
      .regex(/^(?=.*[0-9])[0-9*]{2,10}$/, 'Use 2 to 10 digits, with * for any digit.')
      .optional(),
    city: z.string().trim().min(2).max(40).optional(),
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'Use a 2-letter state, like AL.')
      .optional(),
    withinMiles: z.int().min(1).max(500).optional(),
  })
  .refine((v) => !v.city === !v.state, {
    message: 'A city needs its state with it.',
    path: ['state'],
  })
  .refine((v) => !v.withinMiles || !!v.city, {
    message: 'A distance needs a city to measure from.',
    path: ['withinMiles'],
  })
  .refine((v) => v.numberType === 'local' || !v.city, {
    message: 'Toll-free numbers have no city.',
    path: ['city'],
  });

/**
 * What the registration wizard asks for before it lets a business submit: the three things a carrier's
 * reviewer goes and looks at. Core decides what each page means; this only fetches them.
 */
const PreflightInput = z.strictObject({
  workspaceId: z.uuid(),
  website: z.string().trim().max(300).optional(),
  /** The privacy policy a reviewer will open: the business's own, or the one we host. */
  policyUrl: z.string().trim().max(300).nullable().optional(),
  optInPath: z.enum(['hosted', 'own_site', 'in_person']),
  /** The page carrying the agreement box, when the chosen path claims one. */
  optInUrl: z.string().trim().max(300).nullable().optional(),
});

export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  // Fly's proxy is the one hop in front, so request.ip is the caller's own address (the booking page's
  // per-address limits); signatures still use WORKER_PUBLIC_URL, never forwarded headers.
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    trustProxy: (_address: string, hop: number) => hop < 1,
  });
  await app.register(formbody);
  // One CORS rule for the app's own screens, and one for a business's own website posting a lead in: a
  // form's key names the sites it may be posted from (M14 slice B), and nothing else may read its answer.
  const corsBase = {
    methods: ['GET', 'POST'] as string[],
    // last-event-id: the website chat's stream picks up where it left off.
    allowedHeaders: ['authorization', 'content-type', 'x-correlation-id', 'last-event-id'],
    maxAge: 600,
  };
  await app.register(cors, {
    delegator: (
      req: FastifyRequest,
      done: (err: Error | null, opts: Record<string, unknown>) => void,
    ) => {
      const form = /^\/intake\/f\/(ik_[A-Za-z0-9]{20})/.exec(req.url);
      if (!form) return done(null, { ...corsBase, origin: [...deps.webOrigins] });
      void formOrigins(deps, form[1]!).then(
        (origins) =>
          done(null, {
            ...corsBase,
            methods: ['POST', 'OPTIONS'],
            allowedHeaders: ['content-type'],
            origin: origins.length ? origins : false,
          }),
        () => done(null, { ...corsBase, origin: false }),
      );
    },
  });

  // Every error body says what a client keeping a queue should do with it (`disposition`: final, retry or ask),
  // the same shape as the API's.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HfosError) return reply.code(err.status).send(err.toBody());
    if (err instanceof ProviderError)
      return reply.code(502).send({
        error: {
          code: 'internal',
          message: 'The phone carrier did not answer. Try again in a minute.',
          disposition: 'retry',
        },
      });
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: {
          code: 'validation',
          message: message ?? 'Bad request.',
          disposition: dispositionOf(status),
        },
      });
    deps.log.error({ err }, 'worker http error');
    return reply.code(500).send(HfosError.internal().toBody());
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(HfosError.noSuchRoute().toBody()));

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
  // The AI teammate answering calls live (M18 step 5): Twilio streams the call to it over a websocket.
  await registerVoiceAgentRoute(app, deps);
  registerEmailRoutes(app, deps);
  registerOAuthRoutes(app, deps);
  // Signing in to the CRM a business is leaving (M11).
  if (deps.migrationAdapters) registerMigrationRoutes(app, deps, deps.migrationAdapters);
  // The stand-in provider's own payment page; it registers nothing when the real providers are configured.
  registerFakePaymentRoutes(app, deps);
  registerAssistantRoutes(app, deps, deps.assistant ?? null);
  registerTeammateRoutes(app, deps);
  await registerBookingRoutes(app, deps);
  // The customer's own estimate and invoice pages, and the two payment providers' webhooks.
  await registerMoneyRoutes(app, deps);
  // A customer's own link for the business to copy: minting one needs the worker's key.
  registerMoneyLinkRoutes(app, deps);
  registerWalletCardRoutes(app, deps);
  await registerChatRoutes(app, deps);
  await registerFormRoutes(app, deps);
  await registerSiteRoutes(app, deps);
  await registerLegalRoutes(app, deps);
  await registerFoundingRoutes(app, deps);
  // A form on the business's own website, and services sending leads over (M14 slice B).
  await registerIntakeRoutes(app, deps);
  await registerKnowledgeRoutes(app, deps);
  await registerWorkflowRoutes(app, deps);
  await registerBuilderRoutes(app, deps);
  await registerTemplateRoutes(app, deps);
  if (deps.testRoutes) registerTestRoutes(app, deps, deps.testRoutes);

  app.post('/v1/telephony/available-numbers', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(AvailableNumbersInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const numbers = await deps.telephony.searchNumbers({
      numberType: input.numberType,
      ...(input.areaCode ? { areaCode: input.areaCode } : {}),
      ...(input.contains ? { contains: input.contains } : {}),
      ...(input.city && input.state ? { city: input.city, state: input.state.toUpperCase() } : {}),
      ...(input.withinMiles ? { withinMiles: input.withinMiles } : {}),
      limit: 10,
    });
    return { numbers: numbers.map((n) => ({ ...n, display: formatPhone(n.e164) })) };
  });

  app.post('/v1/telephony/registration-preflight', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(PreflightInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');

    /**
     * One address, fetched as forgivingly as the check allows: a reviewer would follow redirects and would
     * not mind a slow page, so neither do we. Anything that goes wrong becomes a FetchedPage saying so,
     * because "we could not open it" is itself one of the answers core knows how to read.
     */
    const open = async (raw: string | null | undefined): Promise<FetchedPage | null> => {
      const url = (raw ?? '').trim();
      if (!url) return null;
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      try {
        const res = await deps.fetchUrl(full, { timeoutMs: 8000, maxBytes: 512_000 });
        return { url: full, status: res.status, html: res.body, finalUrl: res.finalUrl };
      } catch (err) {
        const code = err instanceof SafeFetchError ? err.code : 'network';
        return { url: full, status: null, html: '', error: code };
      }
    };

    // Fetched together: three sequential round trips would have the business watching a spinner for
    // the better part of half a minute.
    const [website, policy, optIn] = await Promise.all([
      open(input.website),
      open(input.policyUrl),
      input.optInPath === 'in_person' ? Promise.resolve(null) : open(input.optInUrl),
    ]);

    return {
      checks: [
        checkWebsite(website),
        checkPolicy(policy),
        checkOptInSurface(optIn, input.optInPath),
      ],
    };
  });

  return app;
}
