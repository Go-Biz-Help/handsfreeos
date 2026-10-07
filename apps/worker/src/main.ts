import { hostname } from 'node:os';
import { TELEPHONY_BUCKET } from '@hfos/core';
import { createTokenVerifier } from '@hfos/core/server';
import { createDb } from '@hfos/db/client';
import pino from 'pino';
import { createAuthAdmin } from './account/auth-admin';
import { ADDON_WORKER_MODULES } from './addons/modules';
import { claudeWithBackup, createAi, createAiSwitch } from './ai/provider';
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
import { createMeta } from './social/index';
import { createMailboxes } from './mailbox/index';
import { createUnsubscribeLinks } from './email/unsubscribe';
import { createMoneyLinks } from './money/links';
import { createPortalLinks } from './portal/links';
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
import { createModelPicker, createSpeech, createVoiceAi } from './voice-agent/index';
import { createGeocoder } from './geo/geocoder';
import { createOpinly } from './opinly';
import { createTranscriber } from './telephony/transcriber';
import { createFfmpegConverter } from './telephony/video';
import { createWorkflowAi } from './workflows/ai-runner';
import type { EngineServices } from './workflows/types';

loadEnv();
const env = readEnv();
const log = pino(
  env.production
    ? { level: env.logLevel }
    : { level: env.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
);

// The four loops below run side by side, and a handler inside a transaction can take a second connection.
const handle = createDb(env.databaseUrl, { max: 8, applicationName: 'hfos-worker' });
// Webhooks, sign-ins and the Assistant's questions; each question holds a connection only per step.
const httpHandle = createDb(env.databaseUrl, { max: 6, applicationName: 'hfos-worker-http' });
const mailer = createSmtpMailer(env.smtpUrl, env.mailFrom);
// Which AI answers: Claude, or OpenAI while Claude is in trouble (ai/switch.ts). Null without OPENAI_API_KEY.
const aiSwitch = createAiSwitch(env, { db: handle.db, log, mailer });
// Workflow AI steps, the AI builder and the knowledge base: the Assistant's model and daily limit.
const ai = createAi(
  env,
  aiSwitch,
  ADDON_WORKER_MODULES.flatMap((m) => m.scriptedTeammate ?? []),
);
const telephony = createTelephony(env, log);
// The usage wallet (M16). `off` until somebody turns it on: a repo that starts charging the day it deploys
// would be a nasty surprise, and every step of the rollout is a decision.
const wallet = { db: handle.db, log, mode: env.walletMode };
const services: EngineServices = {
  db: handle.db,
  mailer,
  store:
    env.supabaseUrl && env.supabaseSecretKey
      ? createSupabaseStore(env.supabaseUrl, env.supabaseSecretKey)
      : unconfiguredStore,
  log,
  webUrl: env.webUrl,
  publicUrl: env.publicUrl,
  storageUrl: env.supabaseUrl,
  telephony,
  transcriber: createTranscriber(env, log, telephony),
  video: createFfmpegConverter({ log }),
  geocoder: createGeocoder(env, log),
  driving: createDriveTimer(env, log),
  speech: createSpeech(env, log),
  voiceAi: createVoiceAi(env, aiSwitch),
  aiFor: createModelPicker(env, aiSwitch),
  siteHost: createSiteHost(env),
  // With Supabase's admin key it can also read the website visitor a person signed up as (opinly.ts).
  opinly: createOpinly(
    env.opinlyApiKey,
    env.supabaseUrl && env.supabaseSecretKey
      ? { url: env.supabaseUrl, secretKey: env.supabaseSecretKey }
      : null,
  ),
  wallet,
  sealer: createSealer(env.encryptionKey, env.encryptionKeysPrevious),
  addonConnect: { fake: env.addonConnectors === 'fake', platformKeys: env.addonPlatformKeys },
  reminderOverrideMs: env.reminderOverrideMs,
  registrationPollMs: env.registrationPollMs,
  portPollMs: env.portPollMs,
  numberImportPollMs: env.numberImportPollMs,
  email: createEmail(env, log),
  mailboxes: createMailboxes(env),
  calendars: createCalendars(env),
  reviews: createReviews(env),
  social: createMeta(env),
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
  portalLinks: createPortalLinks({
    webUrl: env.webUrl,
    key: env.encryptionKey,
    previousKeys: env.encryptionKeysPrevious,
  }),
  unsubscribeLinks: createUnsubscribeLinks({
    webUrl: env.webUrl,
    publicUrl: env.publicUrl,
    key: env.encryptionKey,
    previousKeys: env.encryptionKeysPrevious,
  }),
  // Local test sites (FETCH_TEST_ORIGINS, for Playwright's website scan) only with the fake carrier, never in production.
  fetchUrl: createSafeFetch({
    testOrigins: !env.production && env.telephonyProvider === 'fake' ? env.fetchTestOrigins : [],
  }),
  ai,
  aiSwitch,
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
    ? claudeWithBackup(
        env,
        aiSwitch,
        { model: env.assistantModel, toolSearch: env.assistantToolSearch },
        { model: env.openAiAssistantModel, toolSearch: env.assistantToolSearch },
      )
    : env.assistantProvider === 'scripted'
      ? scriptedAssistant()
      : null;

// Cloudflare Turnstile: one widget for app.handsfreeos.com serves booking pages, our forms and the website chat.
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

let running = true;

/**
 * One loop per queue, each on its own: a workflow step waiting minutes on the AI, or a slow import, holds up
 * its own queue and nothing else, so a text that came in still gets its reply. A loop that claimed a full batch
 * goes again straight away; one that found less waits for the next poll.
 */
function runLoop(
  name: string,
  pass: () => Promise<{ claimed: number }>,
  opts: { readonly drain: boolean },
): Promise<void> {
  return (async () => {
    while (running) {
      let claimed = 0;
      try {
        const stats = await pass();
        claimed = stats.claimed;
        if (claimed > 0) log.info(stats, `${name} pass`);
      } catch (e) {
        log.error({ err: e, loop: name }, 'worker pass crashed');
      }
      if (running && !(opts.drain && claimed >= env.batchSize))
        await new Promise((r) => setTimeout(r, env.pollMs));
    }
  })();
}
const loops = [
  runLoop('outbox', () => processOnce({ ...loopDeps, handlers }), { drain: true }),
  runLoop('webhook', () => processDeliveries({ ...loopDeps, processors }), { drain: true }),
  runLoop('jobs', () => processJobs({ ...loopDeps, jobs }), { drain: true }),
  // Moving a business here from another CRM: its own leased batches, each pass bounded by its page budget, and
  // a pause between passes like before.
  runLoop('migration', () => processMigrationJobs({ ...loopDeps, adapters: migrationAdapters }), {
    drain: false,
  }),
];

const shutdown = async (signal: string) => {
  running = false;
  aiSwitch?.stop();
  log.info({ signal }, 'worker stopping: closing the listener, then finishing the current passes');
  await app.close();
  await Promise.all(loops);
  await Promise.all([handle.close(), httpHandle.close()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
