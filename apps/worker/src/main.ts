import { hostname } from 'node:os';
import { AnthropicProvider } from '@hfos/ai';
import { TELEPHONY_BUCKET } from '@hfos/core';
import { createTokenVerifier } from '@hfos/core/server';
import { createDb } from '@hfos/db/client';
import pino from 'pino';
import { createAuthAdmin } from './account/auth-admin';
import { createAi } from './ai/provider';
import { scriptedAssistant } from './assistant/scripted';
import { createToolExecutor } from './assistant/tools-write';
import { createBotCheck } from './booking/bot-check';
import { createBookingLinks } from './booking/links';
import { createSealer } from './crypto';
import { createEmail } from './email/index';
import { processDeliveries } from './deliveries';
import { loadEnv, readEnv, supabaseKeyLooksRight } from './env';
import { handlers } from './handlers/index';
import { createCalendars } from './calendar/index';
import { createReviews } from './reviews/index';
import { createMailboxes } from './mailbox/index';
import { createMoneyLinks } from './money/links';
import { createMigrationAdapters } from './migrations/adapters/registry';
import { processMigrationJobs } from './migrations/engine/run';
import { createPayments } from './payments/index';
import { createPush } from './push/index';
import { createSafeFetch } from './http/safe-fetch';
import { buildHttpServer } from './http/server';
import { processJobs } from './jobs';
import { createSmtpMailer } from './mailer';
import { errorMessage, processOnce } from './outbox';
import { processors } from './processors/index';
import { ensureRecurringJobs, jobs } from './scheduled';
import { createSupabaseStore, unconfiguredStore } from './storage';
import { ensurePlatformOwners } from './support/owners';
import { createTelephony } from './telephony/index';
import { createSiteHost } from './hosting';
import { createDriveTimer } from './geo/driving';
import { createSpeech, createVoiceAi } from './voice-agent/index';
import { createGeocoder } from './geo/geocoder';
import { createTranscriber } from './telephony/transcriber';
import { createWorkflowAi } from './workflows/ai-runner';
import type { EngineServices } from './workflows/types';

loadEnv();
const env = readEnv();
const log = pino(
  env.production
    ? { level: env.logLevel }
    : { level: env.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
);

const handle = createDb(env.databaseUrl, { max: 4, applicationName: 'hfos-worker' });
// Webhooks, sign-ins and the Assistant's questions; each question holds a connection only per step.
const httpHandle = createDb(env.databaseUrl, { max: 6, applicationName: 'hfos-worker-http' });
// Workflow AI steps, the AI builder and the knowledge base: the Assistant's model and daily limit.
const ai = createAi(env);
const telephony = createTelephony(env, log);
// The usage wallet (M16). `off` until somebody turns it on: a repo that starts charging the day it deploys
// would be a nasty surprise, and every step of the rollout is a decision.
const wallet = { db: handle.db, log, mode: env.walletMode };
const services: EngineServices = {
  db: handle.db,
  mailer: createSmtpMailer(env.smtpUrl, env.mailFrom),
  store:
    env.supabaseUrl && env.supabaseSecretKey
      ? createSupabaseStore(env.supabaseUrl, env.supabaseSecretKey)
      : unconfiguredStore,
  log,
  webUrl: env.webUrl,
  publicUrl: env.publicUrl,
  telephony,
  transcriber: createTranscriber(env, log, telephony),
  geocoder: createGeocoder(env, log),
  driving: createDriveTimer(env, log),
  speech: createSpeech(env, log),
  voiceAi: createVoiceAi(env),
  siteHost: createSiteHost(env),
  wallet,
  sealer: createSealer(env.encryptionKey, env.encryptionKeysPrevious),
  reminderOverrideMs: env.reminderOverrideMs,
  registrationPollMs: env.registrationPollMs,
  portPollMs: env.portPollMs,
  email: createEmail(env, log),
  mailboxes: createMailboxes(env),
  calendars: createCalendars(env),
  reviews: createReviews(env),
  payments: createPayments(env),
  bookingLinks: createBookingLinks({
    webUrl: env.webUrl,
    key: env.encryptionKey,
    previousKeys: env.encryptionKeysPrevious,
  }),
  moneyLinks: createMoneyLinks({
    webUrl: env.webUrl,
    key: env.encryptionKey,
    previousKeys: env.encryptionKeysPrevious,
  }),
  // Local test sites (FETCH_TEST_ORIGINS, for Playwright's website scan) only with the fake carrier, never in production.
  fetchUrl: createSafeFetch({
    testOrigins: !env.production && env.telephonyProvider === 'fake' ? env.fetchTestOrigins : [],
  }),
  ai,
  // Push notifications to the phone app: Expo's service, or the stand-in locally (push/index.ts).
  push: createPush(env),
  // Deleting an account ends its sessions and blocks sign-in with the worker's own secret key (account/).
  ...(env.supabaseUrl && env.supabaseSecretKey
    ? { authAdmin: createAuthAdmin(env.supabaseUrl, env.supabaseSecretKey) }
    : {}),
  // Workflow AI steps and AI-sorted branches answer from that model, grounded in the knowledge base.
  workflowAi: createWorkflowAi({ db: handle.db, ai, log, wallet }),
  // HandsFreeOS's own support desk (M13): where its mail arrives, and who it goes out as.
  support: {
    mailDomain: env.supportMailDomain,
    addresses: env.supportAddresses,
    fromName: env.supportFromName,
    ownerEmails: env.platformOwnerEmails,
  },
};
/**
 * Reading the CRM a business is leaving (M11). `fake` is the stand-in agency the specs migrate from, so an end
 * to end migration can be proved with no account anywhere; production refuses it.
 */
const migrationAdapters = createMigrationAdapters({
  live: env.migrationSource === 'real',
  goHighLevel: {
    clientId: env.goHighLevelClientId ?? '',
    clientSecret: env.goHighLevelClientSecret ?? '',
    configured: !!env.goHighLevelClientId && !!env.goHighLevelClientSecret,
  },
});
// Whoever runs HandsFreeOS is a support admin at every start, so losing the last admin row locks nobody out.
await ensurePlatformOwners(handle.db, env.platformOwnerEmails, log);

const workerId = `${hostname()}:${process.pid}`;
const loopDeps = { ...services, workerId, batchSize: env.batchSize };

const model =
  env.assistantProvider === 'anthropic' && env.anthropicApiKey
    ? new AnthropicProvider({ apiKey: env.anthropicApiKey, model: env.assistantModel })
    : env.assistantProvider === 'scripted'
      ? scriptedAssistant()
      : null;

// Cloudflare Turnstile: one widget for app.handsfreeos.com serves the booking pages and the website chat.
const botCheck = createBotCheck(env.turnstileSecretKey);
const app = await buildHttpServer({
  ...services,
  httpDb: httpHandle.db,
  verifyToken:
    env.jwksUrl && env.jwtIssuer
      ? createTokenVerifier({ jwksUrl: env.jwksUrl, jwtIssuer: env.jwtIssuer })
      : null,
  webOrigins: env.webOrigins,
  booking: {
    botCheck,
    limitFactor: env.bookingRateLimitFactor,
  },
  chat: {
    ipKey: env.chatIpKey,
    botCheck,
    limitFactor: env.bookingRateLimitFactor,
  },
  // Playwright runs due jobs (and scans its local test site) through test routes; only with the fake carrier,
  // never in production.
  testRoutes:
    !env.production && env.telephonyProvider === 'fake'
      ? { jobs, fetchTestOrigins: env.fetchTestOrigins }
      : null,
  assistant: model
    ? {
        provider: model,
        tools: createToolExecutor(
          httpHandle.db,
          { ai, log, wallet },
          { ai, log, wallet },
          env.webUrl,
        ),
        dailyTokens: env.assistantDailyTokens,
      }
    : null,
  migrationAdapters,
});
await app.listen({ port: env.httpPort, host: env.httpHost });
await ensureRecurringJobs(services);

log.info(
  {
    pollMs: env.pollMs,
    http: `${env.httpHost}:${env.httpPort}`,
    publicUrl: env.publicUrl,
    telephony: services.telephony.name,
    email: services.email.transport.name,
    mailboxes: env.mailboxProvider,
    calendars: env.calendarProvider,
    payments: env.paymentsProvider,
    migrations: env.migrationSource,
    push: env.pushProvider,
    assistant: env.assistantProvider,
    handlers: Object.keys(handlers),
    storage: !!env.supabaseSecretKey,
  },
  'worker started',
);
if (!env.supabaseSecretKey)
  log.warn(
    'SUPABASE_SECRET_KEY is not set: file removals, imports and photos will fail until it is',
  );
else {
  if (!supabaseKeyLooksRight(env.supabaseSecretKey))
    log.error(
      'SUPABASE_SECRET_KEY does not look like a Supabase key. It should be the sb_secret_… key from Project ' +
        'Settings → API Keys, or a legacy service_role JWT — not the publishable key and not the JWT secret.',
    );
  // A key that is set is not a key that works, and until now the difference only showed when a customer left a
  // voicemail and nothing came of it. One list of one bucket at startup says which it is.
  void services.store
    .check(TELEPHONY_BUCKET)
    .then((result) => {
      if (result.ok) log.info('storage ready');
      else
        log.error(
          { err: result.error },
          'Supabase Storage would not take SUPABASE_SECRET_KEY: recordings, photos and imports will fail',
        );
    })
    .catch((err: unknown) =>
      log.error({ err: errorMessage(err) }, 'could not reach Supabase Storage at startup'),
    );
}
if (env.pushProvider === 'none')
  log.warn('EXPO_ACCESS_TOKEN is not set: push notifications to phones are off until it is');

let running = true;
let inFlight: Promise<void> = Promise.resolve();

const tick = async () => {
  try {
    const outbox = await processOnce({ ...loopDeps, handlers });
    if (outbox.claimed > 0) log.info(outbox, 'outbox pass');
    const deliveries = await processDeliveries({ ...loopDeps, processors });
    if (deliveries.claimed > 0) log.info(deliveries, 'webhook pass');
    const due = await processJobs({ ...loopDeps, jobs });
    if (due.claimed > 0) log.info(due, 'jobs pass');
    // Moving a business here from another CRM: its own leased batches, so a long import never holds up
    // a text going out.
    const moving = await processMigrationJobs({ ...loopDeps, adapters: migrationAdapters });
    if (moving.claimed > 0) log.info(moving, 'migration pass');
  } catch (e) {
    log.error({ err: e }, 'worker pass crashed');
  }
};
const loop = async () => {
  while (running) {
    inFlight = tick();
    await inFlight;
    if (running) await new Promise((r) => setTimeout(r, env.pollMs));
  }
};
void loop();

const shutdown = async (signal: string) => {
  running = false;
  log.info({ signal }, 'worker stopping: closing the listener, then finishing the current pass');
  await app.close();
  await inFlight;
  await Promise.all([handle.close(), httpHandle.close()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
