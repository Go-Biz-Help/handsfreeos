import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  APP_HEADERS,
  appVersionAtLeast,
  HfosError,
  isAppRequest,
  VIEW_AS_HEADER,
} from '@hfos/core/server';
import { createDb, type DbHandle } from '@hfos/db/client';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { bearerToken, createTokenVerifier, type TokenVerifier } from './auth';
import { correlationIdFor } from './context';
import type { ApiEnv } from './env';
import { errorHandler } from './errors';
import { registerOperations } from './routes';

export interface BuildOptions {
  readonly env: ApiEnv;
  readonly logger?: boolean | object;
  /** Share a handle (tests); otherwise one pool is created from env.databaseUrl and closed with the app. */
  readonly db?: DbHandle;
  readonly verifyToken?: TokenVerifier;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: opts.env.logLevel },
    // Fly's proxy is the one hop in front: trust only the address it appends, not the X-Forwarded-For a caller
    // sent, so req.ip (rate limits, the audit log) can't be forged. `true` would take the leftmost, caller-chosen one.
    trustProxy: opts.env.trustProxy ? (_address: string, hop: number) => hop < 1 : false,
    genReqId: (req) => correlationIdFor(req.headers['x-correlation-id']),
    bodyLimit: 256 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send(HfosError.noSuchRoute().toBody());
  });

  // Six per machine: Fly runs the API on two, and even on Supavisor's session mode, where every open connection
  // holds one of the role's pool slots (15 by default), two machines at their busiest (12) fit with room to spare.
  const db = opts.db ?? createDb(opts.env.databaseUrl, { max: 6, applicationName: 'hfos-api' });
  if (!opts.db) app.addHook('onClose', async () => db.close());
  const verifyToken = opts.verifyToken ?? createTokenVerifier(opts.env);

  await app.register(helmet, { global: true, contentSecurityPolicy: false });
  await app.register(cors, {
    origin: [...opts.env.webOrigins],
    credentials: false,
    // x-hfos-view-as: the view a request is in (20261018000100), which the web sends from its cookie.
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-correlation-id',
      'x-hfos-reason',
      VIEW_AS_HEADER,
    ],
    exposedHeaders: ['x-correlation-id', 'x-hfos-events'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'HandsFreeOS API',
        version: '0.1.0',
        description:
          'Every write goes through a command; every read through a query. Same operations for the web app, mobile, the assistant and integrations. The phone app sends x-hfos-client: mobile with x-hfos-app-version, and on every command x-hfos-command-id (a repeat gets the first answer back), x-hfos-occurred-at and x-hfos-sent-at (its own clock, corrected here), and x-hfos-confirmed-at after "Still send?". Every error body carries a disposition: final, retry or ask. A request may name the view it is in with x-hfos-view-as (a teammate_view id): its look-ups in that view’s business are read as the teammate, and changes there are refused.',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  if (opts.env.serveDocs) await app.register(swaggerUi, { routePrefix: '/docs' });

  app.decorateRequest('actor', null);
  app.decorateRequest('sentBody', null);
  app.addHook('onSend', async (req, reply) => {
    void reply.header('x-correlation-id', req.id);
  });

  app.get('/healthz', { schema: { tags: ['system'], security: [] } }, async () => ({
    ok: true,
    service: 'api',
    time: new Date().toISOString(),
  }));
  if (opts.env.serveDocs)
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await app.register(async (v1) => {
    v1.addHook('onRequest', async (req) => {
      // An app build older than the API takes is told so first: it pauses and keeps its changes until updated.
      const minimum = opts.env.minAppVersion;
      if (minimum && isAppRequest(req.headers)) {
        const version = req.headers[APP_HEADERS.appVersion];
        if (!appVersionAtLeast(Array.isArray(version) ? version[0] : version, minimum))
          throw HfosError.upgradeRequired(minimum);
      }
      const token = bearerToken(req.headers.authorization);
      if (!token) throw HfosError.unauthenticated();
      req.actor = await verifyToken(token);
    });
    // The body as the client sent it, before validation fills in defaults: what a command's receipt hashes, so a
    // repeat after a release that adds a field still matches.
    v1.addHook('preValidation', async (req) => {
      req.sentBody = req.body;
    });
    registerOperations(v1, db.db);
  });

  return app;
}
