import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import {
  checkOptInSurface,
  checkPolicy,
  checkTerms,
  checkWebsite,
  dispositionOf,
  formatPhone,
  HfosError,
  type FetchedPage,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { telephonyAccounts } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerTeammateRoutes } from '../ai-team/routes';
import { registerAssistantRoutes } from '../assistant/routes';
import { registerKnowledgeRoutes } from '../knowledge/routes';
import { registerMoneyLinkRoutes } from '../money/link-routes';
import { registerWalletCardRoutes } from '../money/wallet-card-routes';
import { registerFakePaymentRoutes } from '../payments/fake-routes';
import { loadAccount } from '../telephony/accounts';
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
import { registerUnsubscribeRoutes } from './unsubscribe';
import { registerSafetyRoutes } from './safety';
import { registerAiCallRoutes } from './ai-calls';
import { registerChatRoutes } from './chat';
import { registerPortalRoutes } from './portal';
import { formOrigins, registerIntakeRoutes } from './intake';
import { registerFormRoutes } from './forms';
import { registerAddonActionRoutes } from './addon-actions';
import { registerAddonConnectionRoutes } from './addon-connections';
import { registerAddonPublicRoutes } from './addon-public';
import { registerAddonSignInRoutes } from './addon-sign-ins';
import { registerAddonWebhookRoutes } from './addon-webhooks';
import { registerVideoLinkRoutes } from './video-links';
import { registerFoundingRoutes } from './founding';
import { registerLegalRoutes } from './legal';
import { SafeFetchError } from './safe-fetch';
import { registerSiteRoutes } from './sites';
import { registerSpeechRoutes } from './speech';
import { registerEmailRoutes } from './email';
import { registerMoneyRoutes } from './money';
import { registerMigrationRoutes } from './migrations';
import { registerNumberImportRoutes } from './number-import';
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

const RcsSendersInput = z.strictObject({ workspaceId: z.uuid() });
const TelephonyAccountInput = z.strictObject({ workspaceId: z.uuid() });

/**
 * What the registration wizard asks for before it lets a business submit: the four things a carrier's
 * reviewer goes and looks at. Core decides what each page means; this only fetches them.
 */
const PreflightInput = z.strictObject({
  workspaceId: z.uuid(),
  website: z.string().trim().max(300).optional(),
  /** The privacy policy a reviewer will open: the business's own, or the one we host. */
  policyUrl: z.string().trim().max(300).nullable().optional(),
  optInPath: z.enum(['hosted', 'own_site', 'in_person']),
  /** The terms a reviewer will open: the business's own, or the ones we host. */
  termsUrl: z.string().trim().max(300).nullable().optional(),
  /** The page carrying the agreement box, when the chosen path claims one. */
  optInUrl: z.string().trim().max(300).nullable().optional(),
  /** In person: a link to a photo of the sign-up sheet or the words said on the phone. */
  optInProofUrl: z.string().trim().max(500).nullable().optional(),
  /** The ways the business is known (its name and legal name), looked for on the website and beside the box. */
  names: z.array(z.string().trim().max(120)).max(4).default([]),
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
    // An RCS-first text can be `sent` twice under one sid — over RCS, then as the SMS it fell back to — and the
    // second says which way it really went (0103), so the two are kept apart rather than one dropped as a replay.
    dedupeKey: (p) =>
      p['MessageSid'] && p['MessageStatus']
        ? `${p['MessageSid']}:${p['MessageStatus']}:${p['ErrorCode'] ?? ''}${/^rcs:/i.test(p['From'] ?? '') ? ':rcs' : ''}`
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
  // Talking out loud: the Assistant's voice mode and the test console's calls, on the web and the phone.
  await registerSpeechRoutes(app, deps);
  await registerBookingRoutes(app, deps);
  // The customer's own estimate and invoice pages, and the two payment providers' webhooks.
  await registerMoneyRoutes(app, deps);
  // A customer's own link for the business to copy: minting one needs the worker's key.
  registerMoneyLinkRoutes(app, deps);
  await registerUnsubscribeRoutes(app, deps);
  // An outside safety contact's page (round six).
  await registerSafetyRoutes(app, deps);
  registerAiCallRoutes(app, deps);
  // Bringing a number that already lives in Twilio: a business's own account, or HighLevel's (20261010000900).
  registerNumberImportRoutes(app, deps);
  registerWalletCardRoutes(app, deps);
  await registerChatRoutes(app, deps);
  // A customer's own portal: their private link, the code emailed to them, and the device it signs in.
  await registerPortalRoutes(app, deps);
  await registerFormRoutes(app, deps);
  // Add-ons' public pages: a listing's page, an open house's sign-in.
  await registerAddonPublicRoutes(app, deps);
  // An add-on's accounts at other services: a pasted key, tried and sealed, and their updates (round five).
  registerAddonConnectionRoutes(app, deps, deps.addonConnections);
  await registerAddonWebhookRoutes(app, deps, deps.addonConnections);
  registerAddonSignInRoutes(app, deps, deps.addonConnections);
  registerAddonActionRoutes(app, deps, deps.addonConnections);
  // A customer sending a video at full quality through a link the business texted them (20261018000300).
  await registerVideoLinkRoutes(app, deps);
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

  /**
   * The RCS senders in the business's own Twilio account (0103), for Settings to offer before anything is
   * connected. Twilio makes senders only in its console, so this is how a business sees the one it made — and,
   * when there is none, which account to make it in.
   */
  app.post('/v1/telephony/rcs-senders', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(RcsSendersInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const account = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, (tx) =>
      loadAccount(tx, input.workspaceId, deps.sealer),
    );
    if (!account) return { accountSid: null, senders: [] };
    const senders = await deps.telephony.listRcsSenders(account);
    return {
      accountSid: account.sid,
      senders: senders.map((x) => ({
        sid: x.sid,
        senderId: x.senderId,
        displayName: x.displayName,
        state: x.state,
        providerStatus: x.providerStatus,
      })),
    };
  });

  /**
   * Phone & texting on or off, and the business's own Twilio Account SID while it is on: what HighLevel or Twilio
   * asks for to move a number here. The SID is an identifier, not a secret, but it lives beside sealed ones, so
   * people read it through here rather than from the table.
   */
  app.post('/v1/telephony/account', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(TelephonyAccountInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const [row] = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, (tx) =>
      tx
        .select({
          status: telephonyAccounts.status,
          accountSid: telephonyAccounts.accountSid,
          lastError: telephonyAccounts.lastError,
        })
        .from(telephonyAccounts)
        .where(eq(telephonyAccounts.workspaceId, input.workspaceId)),
    );
    const on = !!row && row.status !== 'closed';
    return {
      state: !on ? 'off' : row.status === 'provisioning' ? 'turning_on' : 'on',
      accountSid: on ? row.accountSid : null,
      // HandsFreeOS's own parent account, which every business's sits under. HighLevel's move form asks for
      // it beside the sub-account's. An identifier like the other, never a key.
      parentAccountSid: deps.telephony.masterAccountSid,
      lastError: row?.lastError ?? null,
    };
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

    // Fetched together: four sequential round trips would have the business watching a spinner for
    // the better part of half a minute.
    const names = input.names.filter(Boolean);
    const [website, policy, terms, optIn] = await Promise.all([
      open(input.website),
      open(input.policyUrl),
      open(input.termsUrl),
      open(input.optInPath === 'in_person' ? input.optInProofUrl : input.optInUrl),
    ]);

    return {
      checks: [
        checkWebsite(website, names),
        checkPolicy(policy),
        checkTerms(terms),
        checkOptInSurface(optIn, input.optInPath, names),
      ],
    };
  });

  return app;
}
