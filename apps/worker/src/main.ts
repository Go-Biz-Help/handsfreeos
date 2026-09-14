import { hostname } from 'node:os';
import { AnthropicProvider } from '@hfos/ai';
import { createTokenVerifier } from '@hfos/core/server';
import { createDb } from '@hfos/db/client';
import pino from 'pino';
import { scriptedAssistant } from './assistant/scripted';
import { createToolExecutor } from './assistant/tools-write';
import { createBotCheck } from './booking/bot-check';
import { createBookingLinks } from './booking/links';
import { createSealer } from './crypto';
import { createEmail } from './email/index';
import { processDeliveries } from './deliveries';
import { loadEnv, readEnv } from './env';
import { handlers } from './handlers/index';
import { createCalendars } from './calendar/index';
import { createMailboxes } from './mailbox/index';
import { createSafeFetch } from './http/safe-fetch';
import { buildHttpServer } from './http/server';
import { processJobs } from './jobs';
import { createSmtpMailer } from './mailer';
import { processOnce } from './outbox';
import { processors } from './processors/index';
import { ensureRecurringJobs, jobs } from './scheduled';
import type { WorkerServices } from './services';
import { createSupabaseStore, unconfiguredStore } from './storage';
import { createTelephony } from './telephony/index';

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
const services: WorkerServices = {
  db: handle.db,
  mailer: createSmtpMailer(env.smtpUrl, env.mailFrom),
  store:
    env.supabaseUrl && env.supabaseSecretKey
      ? createSupabaseStore(env.supabaseUrl, env.supabaseSecretKey)
      : unconfiguredStore,
  log,
  webUrl: env.webUrl,
  publicUrl: env.publicUrl,
  telephony: createTelephony(env, log),
  sealer: createSealer(env.encryptionKey, env.encryptionKeysPrevious),
  reminderOverrideMs: env.reminderOverrideMs,
  registrationPollMs: env.registrationPollMs,
  email: createEmail(env, log),
  mailboxes: createMailboxes(env),
  calendars: createCalendars(env),
  bookingLinks: createBookingLinks({
    webUrl: env.webUrl,
    key: env.encryptionKey,
    previousKeys: env.encryptionKeysPrevious,
  }),
  fetchUrl: createSafeFetch(),
};
const workerId = `${hostname()}:${process.pid}`;
const loopDeps = { ...services, workerId, batchSize: env.batchSize };

const model =
  env.assistantProvider === 'anthropic' && env.anthropicApiKey
    ? new AnthropicProvider({ apiKey: env.anthropicApiKey, model: env.assistantModel })
    : env.assistantProvider === 'scripted'
      ? scriptedAssistant()
      : null;

const app = await buildHttpServer({
  ...services,
  httpDb: httpHandle.db,
  verifyToken:
    env.jwksUrl && env.jwtIssuer
      ? createTokenVerifier({ jwksUrl: env.jwksUrl, jwtIssuer: env.jwtIssuer })
      : null,
  webOrigins: env.webOrigins,
  booking: {
    botCheck: createBotCheck(env.turnstileSecretKey),
    limitFactor: env.bookingRateLimitFactor,
  },
  // Playwright runs due jobs through a test route; only with the fake carrier, never in production.
  testRoutes: !env.production && env.telephonyProvider === 'fake' ? { jobs } : null,
  assistant: model
    ? {
        provider: model,
        tools: createToolExecutor(httpHandle.db),
        dailyTokens: env.assistantDailyTokens,
      }
    : null,
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
