import { hostname } from 'node:os';
import { TELEPHONY_BUCKET } from '@hfos/core';
import { createTokenVerifier } from '@hfos/core/server';
import { createDb } from '@hfos/db/client';
import pino from 'pino';
import { claudeWithBackup } from './ai/provider';
import { settleAssistantRuns } from './assistant/routes';
import { scriptedAssistant } from './assistant/scripted';
import { createToolExecutor } from './assistant/tools-write';
import { createBotCheck } from './booking/bot-check';
import { processDeliveries } from './deliveries';
import { mailDns } from './email/dns';
import { loadEnv, readEnv, supabaseKeyLooksRight } from './env';
import { handlers } from './handlers/index';
import { createMigrationAdapters } from './migrations/adapters/registry';
import { processMigrationJobs } from './migrations/engine/run';
import { PAYMENT_NAME, WEBHOOK_SECRET_SETTING } from './payments/index';
import { queuesWaiting, runQueues } from './queues';
import { buildHttpServer } from './http/server';
import { processJobs } from './jobs';
import { runLoop } from './loop';
import { errorMessage, processOnce } from './outbox';
import { processors } from './processors/index';
import { ensureRecurringJobs, jobs } from './scheduled';
import { createEngineServices } from './services-env';
import { ensurePlatformOwners } from './support/owners';

loadEnv();
const env = readEnv();
const log = pino(
  env.production
    ? { level: env.logLevel }
    : { level: env.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
);

// The loops below run side by side, and a handler inside a transaction can take a second connection.
const handle = createDb(env.databaseUrl, { max: 8, applicationName: 'hfos-worker' });
// Webhooks, sign-ins and the Assistant's questions; each question holds a connection only per step.
const httpHandle = createDb(env.databaseUrl, { max: 6, applicationName: 'hfos-worker-http' });
const services = createEngineServices(env, log, handle.db);
const { ai, wallet } = services;
const aiSwitch = services.aiSwitch ?? null;
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
    ? claudeWithBackup(
        env,
        aiSwitch,
        {
          model: env.assistantModel,
          toolSearch: env.assistantToolSearch,
          effort: env.assistantEffort,
        },
        {
          model: env.openAiAssistantModel,
          toolSearch: env.assistantToolSearch,
          reasoningEffort: env.assistantEffort,
        },
      )
    : env.assistantProvider === 'scripted'
      ? scriptedAssistant()
      : null;

/**
 * Each queue's loop, once it runs (below): how one part of the worker tells another there is work for it now. Every
 * hand-over used to wait for the next poll, half a second on average and a second at worst, and an AI reply to a
 * customer's text is four of them: the webhook is stored, its processor leaves an event, the event's handler
 * queues the reply, the reply's job leaves the event that sends it.
 */
const wake: { outbox?: () => void; webhook?: () => void; jobs?: () => void } = {};
/** After work that may have left an event or a job due now. Each loop that is waiting looks once; one in a pass
 * looks again when the pass ends. */
const handedOver = () => {
  wake.outbox?.();
  wake.jobs?.();
};

// Cloudflare Turnstile: one widget for app.handsfreeos.com serves booking pages, our forms and the website chat.
const botCheck = createBotCheck(env.turnstileSecretKey);
const app = await buildHttpServer({
  ...services,
  httpDb: httpHandle.db,
  onDeliveryStored: () => wake.webhook?.(),
  verifyToken:
    env.jwksUrl && env.jwtIssuer
      ? createTokenVerifier({ jwksUrl: env.jwksUrl, jwtIssuer: env.jwtIssuer })
      : null,
  webOrigins: env.webOrigins,
  siteReaderIps: env.siteReaderIps,
  booking: {
    botCheck,
    limitFactor: env.bookingRateLimitFactor,
    // Real mail, real DNS: a typed email at a domain that can't take mail is sent back to be fixed.
    ...(env.emailTransport === 'postmark' ? { mailDns } : {}),
  },
  chat: {
    ipKey: env.chatIpKey,
    botCheck,
    limitFactor: env.bookingRateLimitFactor,
  },
  forms: { botCheck },
  // Not intake: a form on the business's own site that carries a Turnstile token carries one for their own
  // widget, which ours can't verify, so checking it would only drop real leads (intake.ts).
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
          // Match my website reads the site through the worker's safe fetch, as the Design tab's route does.
          { ai, log, wallet, fetchUrl: services.fetchUrl },
          env.webUrl,
          undefined,
          // The add-ons' worker actions run as the route runs them, with the worker's services.
          { services },
        ),
      }
    : null,
  migrationAdapters,
});
await app.listen({ port: env.httpPort, host: env.httpHost });
await ensureRecurringJobs(services);
// Where the last check left it (a worker that starts while Claude is down starts on OpenAI), then in step with
// every other machine and support's switch.
if (aiSwitch) {
  await aiSwitch
    .refresh()
    .catch((e: unknown) => log.warn({ err: errorMessage(e) }, 'couldn’t read which AI answers'));
  aiSwitch.watch();
}

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
    // Facebook Messenger and Instagram: `none` until the Meta app's id and secret are here.
    meta: services.social.graph.configured ? env.metaProvider : 'none',
    migrations: env.migrationSource,
    addonConnectors: env.addonConnectors,
    addonPlatformKeys: Object.keys(env.addonPlatformKeys),
    push: env.pushProvider,
    video: env.videoProvider,
    // Which phone voices can speak: Rime's need RIME_API_KEY.
    voices: services.speech?.voices?.() ?? { deepgram: false, rime: false },
    assistant: env.assistantProvider,
    aiBackup: aiSwitch ? 'openai' : 'none',
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
if (env.videoProvider === 'none')
  log.warn(
    'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not set: HandsFreeOS video calls are off until they are',
  );
// A payment app without its webhook secret refuses every event it is sent, and after days of refusals the
// provider turns the endpoint off, as Stripe did on 2026-10-08 with nothing here saying why.
for (const name of ['stripe', 'square'] as const) {
  const provider = services.payments.providers[name];
  if (provider.configured && !provider.webhooks.configured)
    log.error(
      `${WEBHOOK_SECRET_SETTING[name]} is not set: every event ${PAYMENT_NAME[name]} sends is refused ` +
        'until it is, so its payments, refunds and disconnections never reach anyone here',
    );
}

let running = true;

const pace = { pollMs: env.pollMs, batchSize: env.batchSize, running: () => running, log };
/**
 * Moving a business here from another CRM: its own leased batches, each pass bounded by its page budget, and a
 * pause between passes like before. No move is running nearly all the time, so after a quiet minute it looks only
 * every 30 seconds; the outbox loop wakes it when a move's command comes through (`onEvent` below), so pressing
 * Scan or Start still begins within the second.
 */
const migrationLoop = runLoop(
  'migration',
  () => processMigrationJobs({ ...loopDeps, adapters: migrationAdapters }),
  { drain: false, idle: { afterMs: 60_000, everyMs: 30_000 } },
  pace,
);
// The outbox, the webhooks and the jobs: one look a second for all three, and a claim only when there is one to
// make (queues.ts).
const queues = runQueues(
  {
    outbox: () =>
      processOnce({
        ...loopDeps,
        handlers,
        onEvent: (type) => {
          if (type.startsWith('migration.')) migrationLoop.wake();
        },
        onHandled: handedOver,
      }),
    webhook: () => processDeliveries({ ...loopDeps, processors, onProcessed: handedOver }),
    jobs: () => processJobs({ ...loopDeps, jobs, onRan: handedOver }),
  },
  () => queuesWaiting(handle.db, workerId),
  pace,
);
wake.outbox = () => queues.wake('outbox');
wake.webhook = () => queues.wake('webhook');
wake.jobs = () => queues.wake('jobs');
const loops = [...queues.loops, migrationLoop];

/**
 * How long a shutdown lets the Assistant's answers finish, inside fly.toml's 30-second kill_timeout: most people
 * ask and leave, so nothing else would wait for an answer nobody is listening to. One still going then is stopped,
 * and saves a line saying an update cut it off.
 */
const ANSWERS_GRACE_MS = 20_000;

const shutdown = async (signal: string) => {
  running = false;
  // No loop sits out a wait first: the migration one may be half a minute into its own.
  for (const loop of loops) loop.wake();
  aiSwitch?.stop();
  log.info({ signal }, 'worker stopping: closing the listener, then finishing the current passes');
  // The listener closes at once; answers streaming to someone hold it open until they end, so both go together.
  const [, answers] = await Promise.all([app.close(), settleAssistantRuns(ANSWERS_GRACE_MS)]);
  if (answers) log.info({ answers }, 'the Assistant’s answers in progress were let finish');
  await Promise.all(loops.map((loop) => loop.done));
  await Promise.all([handle.close(), httpHandle.close()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
