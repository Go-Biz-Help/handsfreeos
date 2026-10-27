/**
 * The worker's services, made from its environment: what main.ts runs everything with, and what the media process
 * (media.ts) hands the add-ons that hear a HandsFreeOS video call (Sales Coach), so the coach thinks, bills and pushes
 * there exactly as it does on a phone call.
 */
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { WorkerEnv } from './env';
import { createAuthAdmin } from './account/auth-admin';
import { ADDON_WORKER_MODULES } from './addons/modules';
import { createAi, createAiSwitch } from './ai/provider';
import { createBookingLinks } from './booking/links';
import { createSealer } from './crypto';
import { createEmail } from './email/index';
import { createCalendars } from './calendar/index';
import { createReviews } from './reviews/index';
import { createMeta } from './social/index';
import { createMailboxes } from './mailbox/index';
import { createUnsubscribeLinks } from './email/unsubscribe';
import { createMoneyLinks } from './money/links';
import { createPortalLinks } from './portal/links';
import { createPayments } from './payments/index';
import { createPush } from './push/index';
import { createVideoCalls } from './video-calls/index';
import { createSafeFetch } from './http/safe-fetch';
import { createSmtpMailer } from './mailer';
import { createSupabaseStore, unconfiguredStore } from './storage';
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

export function createEngineServices(env: WorkerEnv, log: Logger, db: Db): EngineServices {
  const mailer = createSmtpMailer(env.smtpUrl, env.mailFrom);
  // Which AI answers: Claude, or OpenAI while Claude is in trouble (ai/switch.ts). Null without OPENAI_API_KEY.
  const aiSwitch = createAiSwitch(env, { db: db, log, mailer });
  // Workflow AI steps, the AI builder and the knowledge base: the Assistant's model and daily limit.
  const ai = createAi(
    env,
    aiSwitch,
    ADDON_WORKER_MODULES.flatMap((m) => m.scriptedTeammate ?? []),
  );
  const telephony = createTelephony(env, log);
  // The usage wallet (M16). `off` until somebody turns it on: a repo that starts charging the day it deploys
  // would be a nasty surprise, and every step of the rollout is a decision.
  const wallet = { db: db, log, mode: env.walletMode };
  const services: EngineServices = {
    db: db,
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
    // HandsFreeOS video calls: LiveKit, the stand-in locally, or null before LiveKit is set up (video-calls/).
    videoCalls: createVideoCalls(env),
    // Deleting an account ends its sessions and blocks sign-in with the worker's own secret key (account/).
    ...(env.supabaseUrl && env.supabaseSecretKey
      ? { authAdmin: createAuthAdmin(env.supabaseUrl, env.supabaseSecretKey) }
      : {}),
    // Workflow AI steps and AI-sorted branches answer from that model, grounded in the knowledge base.
    workflowAi: createWorkflowAi({ db: db, ai, log, wallet }),
    // HandsFreeOS's own support desk (M13): where its mail arrives, and who it goes out as.
    support: {
      mailDomain: env.supportMailDomain,
      addresses: env.supportAddresses,
      fromName: env.supportFromName,
      ownerEmails: env.platformOwnerEmails,
    },
  };
  return services;
}
