import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_WEBHOOK_PASSWORD } from './email/local';

/** The website chat's IP-hashing key on your own computer (scripts/supabase-env.mjs); production refuses it. */
export const LOCAL_CHAT_IP_KEY = 'local-chat-ip-key-for-development-only';

export function loadEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * Whether a value is shaped like a key Supabase would take: the new `sb_secret_…` format, or a legacy
 * `service_role` JWT (three dot-separated parts). It says nothing about whether the key is the right one or
 * still valid — only that it is not the publishable key's neighbour, the JWT *secret*, or a password, all of
 * which have been pasted in here and all of which Storage rejects with "Invalid Compact JWS".
 */
export function supabaseKeyLooksRight(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return false;
  if (/^sb_[a-z]+_.+/.test(key)) return true;
  const parts = key.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p) && p.length > 0);
}

export interface WorkerEnv {
  readonly databaseUrl: string;
  /** The Supabase project URL and secret key: the worker is the only app allowed to hold it (Storage deletes, imports). */
  readonly supabaseUrl: string | null;
  readonly supabaseSecretKey: string | null;
  readonly smtpUrl: string;
  readonly mailFrom: string;
  readonly webUrl: string;
  readonly pollMs: number;
  readonly batchSize: number;
  readonly logLevel: string;
  readonly production: boolean;
  /** The worker's small HTTP server: provider webhooks, OAuth callbacks, voice tokens, number search. */
  readonly httpPort: number;
  readonly httpHost: string;
  /** The public base URL providers call (signatures are checked against it, never against the Host header). */
  readonly publicUrl: string;
  readonly webOrigins: readonly string[];
  readonly jwksUrl: string | null;
  readonly jwtIssuer: string | null;
  readonly telephonyProvider: 'twilio' | 'fake';
  /**
   * Who turns a recording into words. `deepgram` reads our own stored copy; `twilio` is Conversational Intelligence,
   * kept as the fallback for an account with no Deepgram key; `fake` is the stand-in for development and tests.
   */
  readonly transcriber: 'deepgram' | 'twilio' | 'fake';
  readonly deepgramApiKey: string | null;
  /**
   * M18: who finds where an address is, for distance and drawn service areas. `google` needs
   * GOOGLE_MAPS_SERVER_KEY; `off` (production without one) means only ZIP areas work; `fake` is the stand-in.
   */
  readonly geocoder: 'google' | 'fake' | 'off';
  readonly googleMapsServerKey: string | null;
  /**
   * M18 step 5: who listens and speaks when the AI teammate answers a call live. `deepgram` needs
   * DEEPGRAM_API_KEY (the same key transcripts use); `off` (production without one) keeps every call ringing
   * the team and going to voicemail; `fake` is the stand-in for development and tests.
   */
  readonly voiceAgent: 'deepgram' | 'fake' | 'off';
  /** The model that thinks on a call; unset uses AI_MODEL. A faster one keeps the pauses short. */
  readonly voiceModel: string | null;
  /**
   * Where a business's own domain is served from (M17). `vercel` is where the web app lives; `fake` is the
   * in-memory stand-in for development and tests. `off` is the honest default for a deployment that has not
   * been given a token yet: the feature is simply not offered, rather than offered and then failing.
   */
  readonly siteHost: 'vercel' | 'fake' | 'off';
  readonly vercelToken: string | null;
  readonly vercelProjectId: string | null;
  readonly vercelTeamId: string | null;
  /**
   * How far the usage wallet (M16) has been rolled out. `off` writes nothing at all; `shadow` prices and
   * records every event but never warns and never stops anything, which is how the rate card gets proved
   * against a real week before a customer is charged; `on` is the real thing, with enforcement still gated
   * per business by its own flag.
   */
  readonly walletMode: 'off' | 'shadow' | 'on';
  readonly twilioAccountSid: string | null;
  readonly twilioAuthToken: string | null;
  /** HandsFreeOS's approved ISV customer profile (BU...): local (10DLC) registrations link under it. */
  readonly twilioPrimaryProfileSid: string | null;
  readonly encryptionKey: string;
  readonly encryptionKeysPrevious: readonly string[];
  /** Local demos and tests shorten the reply reminder (milliseconds); production uses workspace settings. */
  readonly reminderOverrideMs: number | null;
  readonly registrationPollMs: number;
  readonly portPollMs: number;
  /** How often a number being brought over from Twilio or HighLevel is looked for (20261010000900). */
  readonly numberImportPollMs: number;
  readonly fakeApprovalMs: number;
  /** Workspace email: Postmark in production; locally Mailpit over SMTP, with domains that verify themselves. */
  readonly emailTransport: 'postmark' | 'smtp';
  readonly postmarkServerToken: string | null;
  /** The Domains API (workspaces' own domains) needs the account token. */
  readonly postmarkAccountToken: string | null;
  readonly postmarkMessageStream: string;
  /** The Broadcasts stream campaign email goes on (Postmark → the server → Message Streams); null until set. */
  readonly postmarkBroadcastStream: string | null;
  /** Basic auth on Postmark's webhooks (Postmark signs nothing). */
  readonly postmarkWebhookUser: string;
  readonly postmarkWebhookPassword: string;
  /** The shared subdomain (mirrors private.shared_mail_domain()). */
  readonly mailDomain: string;
  /**
   * HandsFreeOS's own support address (M13). Mail to it becomes a ticket rather than landing in a mailbox
   * anybody signs into. It is the bare domain, kept apart from `mailDomain` (the businesses' subdomain), so
   * the two routes can never be confused for one another.
   */
  readonly supportMailDomain: string;
  /** The local parts that open a ticket: support@, help@ and anything else Chris points at us. */
  readonly supportAddresses: readonly string[];
  /** What customers see in the From line of a support reply. */
  readonly supportFromName: string;
  /**
   * The people who are support admins whatever the database says — Chris, and whoever else runs HandsFreeOS.
   * Checked at startup, so there is always a way back in if the last admin row is lost.
   */
  readonly platformOwnerEmails: readonly string[];
  /** Connected mailboxes: Microsoft's and Google's apps, or local mailboxes with a sign-in page on the worker. */
  readonly mailboxProvider: 'real' | 'fake';
  readonly microsoftClientId: string | null;
  readonly microsoftClientSecret: string | null;
  readonly googleClientId: string | null;
  readonly googleClientSecret: string | null;
  /** Tests shorten how often mailboxes are checked (milliseconds). */
  readonly mailboxSyncMs: number | null;
  /** How far back a new mailbox's first sync looks. */
  readonly mailboxBackfillDays: number;
  /**
   * People's own calendars: Google Calendar (its own Google Cloud project) and Outlook (the Microsoft app above,
   * with Calendars.ReadWrite), or local calendars behind the same stand-in sign-in page as mailboxes.
   */
  readonly calendarProvider: 'real' | 'fake';
  readonly googleCalendarClientId: string | null;
  readonly googleCalendarClientSecret: string | null;
  /** How often each connected calendar's busy times are read again (milliseconds; tests shorten it). */
  readonly calendarRefreshMs: number;
  /** Zoom's Marketplace OAuth app, for people's own Zoom accounts (stand-in with CALENDAR_PROVIDER=fake). */
  readonly zoomClientId: string | null;
  readonly zoomClientSecret: string | null;
  /**
   * What customers said in public (M16): the Google Business Profile and the Facebook Page the reviews are
   * read from, or the stand-in that serves its own sign-in page on the worker and keeps reviews in memory.
   */
  readonly reviewProvider: 'real' | 'fake';
  readonly googleReviewClientId: string | null;
  readonly googleReviewClientSecret: string | null;
  readonly facebookAppId: string | null;
  readonly facebookAppSecret: string | null;
  /** How often each connected place is asked for new reviews (milliseconds; tests shorten it). */
  readonly reviewPollMs: number;
  /**
   * Facebook Messenger and Instagram direct messages (20261025000200): the same Meta app as Facebook reviews, or the
   * stand-in that signs in on the worker and keeps Pages and replies in memory. Production refuses the stand-in.
   */
  readonly metaProvider: 'real' | 'fake';
  /** What Meta's webhook setup checks this server with (META_WEBHOOK_VERIFY_TOKEN). */
  readonly metaVerifyToken: string | null;
  /** A Facebook Login for Business configuration (META_LOGIN_CONFIG_ID); without one the sign-in names its permissions. */
  readonly metaLoginConfigId: string | null;
  /** Graph's version, `v26.0` (META_GRAPH_VERSION). */
  readonly metaGraphVersion: string;
  /** Meta approved the Human Agent permission for the app (META_HUMAN_AGENT=on): people may answer for seven days. */
  readonly metaHumanAgent: boolean;
  /**
   * Taking money: Stripe's Connect platform and Square's application, or the stand-in that serves its own
   * payment page on the worker and posts properly signed webhooks back to it. Production refuses the stand-in.
   */
  readonly paymentsProvider: 'real' | 'fake';
  /** Stripe Connect: the platform's `ca_…`, our own secret key, the public key the page loads, and `whsec_…`. */
  readonly stripeClientId: string | null;
  readonly stripeSecretKey: string | null;
  readonly stripePublishableKey: string | null;
  readonly stripeWebhookSecret: string | null;
  /**
   * `whsec_…` of our own account's event destination (0093), for the founding seats' Checkout. A second endpoint
   * in Stripe — "Your account", not "Connected accounts" — so a second secret. Without it the page is still made
   * and paid, but the payment is never heard about, so nobody's seat turns on: set it before opening $497 seats.
   */
  readonly stripePlatformWebhookSecret: string | null;
  /**
   * Opinly's secret `sk-` key: a paid founding seat is reported to the website's marketing analytics, so the payment
   * is credited to the ad or post that brought them (opinly.ts). Unset sends nothing.
   */
  readonly opinlyApiKey: string | null;
  /**
   * What add-ons connect to (round five): the real services, or stand-ins that accept any key but one with "wrong" in
   * it, for development and tests.
   */
  readonly addonConnectors: 'real' | 'fake';
  /**
   * HandsFreeOS's own accounts at the services add-ons connect to, by `<add-on>.<service>` (realestate.repliers):
   * ADDON_PLATFORM_KEYS, a JSON object of each account's fields. Staff turn one on for a business; its key never
   * leaves the worker.
   */
  readonly addonPlatformKeys: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Square: the developer application's id and secret. The id is public and the page loads the SDK with it. */
  readonly squareApplicationId: string | null;
  readonly squareApplicationSecret: string | null;
  /** Comma-separated, so a signature key can be rotated without dropping a webhook in between. */
  readonly squareWebhookSignatureKeys: readonly string[];
  /** Which Square to talk to: its sandbox has its own application and its own hosts. */
  readonly squareEnvironment: 'live' | 'test';
  /**
   * Moving a business here from another CRM (M11). `real` talks to GoHighLevel; `fake` is the stand-in agency
   * the tests and local development migrate from, so nothing ever reaches a real account by accident.
   * Production refuses the stand-in, exactly as payments and telephony do.
   */
  readonly migrationSource: 'real' | 'fake';
  /** The GoHighLevel marketplace app: its client id and secret. Both, or neither. */
  readonly goHighLevelClientId: string | null;
  readonly goHighLevelClientSecret: string | null;
  /** How long the stand-in takes to settle a bank transfer; null (the default) means only when asked. */
  readonly paymentsFakeSettleMs: number | null;
  /** The Assistant: Claude, a scripted stand-in for tests, or none (the panel says it isn't set up). */
  readonly assistantProvider: 'anthropic' | 'scripted' | 'none';
  readonly anthropicApiKey: string | null;
  /**
   * The model behind Ask HandsFreeOS, the team's own helper. It has far more tools than anything else here, so
   * it gets the stronger model; it isn't billed to the business, so its price is HandsFreeOS's own.
   */
  readonly assistantModel: string;
  /**
   * The model for everything else: the AI teammate, calls (unless VOICE_MODEL), workflow steps, the builders and
   * the knowledge base. Customers wait on these, and businesses pay for them at the card's AI rates.
   */
  readonly aiModel: string;
  /**
   * Ask HandsFreeOS loads most of its tools only when it searches for them (Anthropic's tool search), so it picks
   * from a short list rather than every tool at once. On by default; off (ASSISTANT_TOOL_SEARCH=off) sends every
   * tool every time. Models without tool search, such as Claude Sonnet 5, always send every tool.
   */
  readonly assistantToolSearch: boolean;
  /** Tokens one workspace's Assistant may use per day, cache reads and writes included. */
  readonly assistantDailyTokens: number;
  /**
   * OpenAI, the backup for every AI feature while Claude is in trouble (ai/switch.ts). Unset: no backup, Claude
   * alone as before. Only with the Anthropic provider: the scripted stand-in needs none.
   */
  readonly openAiApiKey: string | null;
  /** The backup for AI_MODEL. */
  readonly openAiModel: string;
  /** The backup for ASSISTANT_MODEL. */
  readonly openAiAssistantModel: string;
  /** The backup on calls, whatever model they use on Claude: a fast one keeps the pauses short. */
  readonly openAiVoiceModel: string;
  /** Who is emailed when the AI moves to OpenAI and back (AI_ALERT_EMAILS, else PLATFORM_OWNER_EMAILS). */
  readonly aiAlertEmails: readonly string[];
  /** Cloudflare Turnstile on the public booking page (its site key lives on the web); unset: no bot check. */
  readonly turnstileSecretKey: string | null;
  /**
   * Multiplies the booking page's and the website chat's per-address limits: 1 in production, 10 elsewhere,
   * because local development and Playwright book and chat from one address.
   */
  readonly bookingRateLimitFactor: number;
  /**
   * The key the website chat hashes visitors' IP addresses with (HMAC-SHA256), for its limits and network
   * blocks; the address itself is never stored. Required in production.
   */
  readonly chatIpKey: string;
  /**
   * Local sites a website scan may read over plain http: exact loopback origins, such as the knowledge fixture
   * site Playwright starts (scripts/knowledge-site.ts). Development and tests only: main.ts honours it only
   * with the fake carrier, and production refuses it.
   */
  readonly fetchTestOrigins: readonly string[];
  /**
   * Push notifications to the phone app (push/): Expo's service, the stand-in that keeps what it was handed (the
   * default outside production; production refuses it), or none (production without an access token yet).
   */
  readonly pushProvider: 'expo' | 'fake' | 'none';
  /** Expo's access token for enhanced push security: every push carries it. The worker's alone. */
  readonly expoAccessToken: string | null;
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function readEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const databaseUrl = env.DATABASE_URL_WORKER ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error('DATABASE_URL_WORKER must be a postgres:// URL for the hfos_worker role');
  if (/\/\/postgres[:@]/.test(databaseUrl))
    throw new Error('DATABASE_URL_WORKER must not connect as the postgres role');
  const smtpUrl = env.SMTP_URL ?? '';
  if (!/^smtps?:\/\//.test(smtpUrl)) throw new Error('SMTP_URL must be an smtp:// or smtps:// URL');
  const production = env.NODE_ENV === 'production';
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '') || null;
  // Trimmed: the key is pasted into `fly secrets set` by hand, and a stray space or newline rides along as part
  // of the key. Storage then answers "Invalid Compact JWS" and says nothing about why. A key that still looks
  // wrong is said so at startup (main.ts) rather than refusing to start: storage is one of the worker's jobs,
  // and a business should not lose its texts and calls over a bad paste in an optional value.
  const supabaseSecretKey = (env.SUPABASE_SECRET_KEY ?? '').trim() || null;

  const telephonyProvider = (env.TELEPHONY_PROVIDER ?? (production ? 'twilio' : 'fake')) as string;
  if (telephonyProvider !== 'twilio' && telephonyProvider !== 'fake')
    throw new Error('TELEPHONY_PROVIDER must be twilio or fake');
  if (production && telephonyProvider === 'fake')
    throw new Error('TELEPHONY_PROVIDER=fake is for development and tests only');
  const deepgramApiKey = env.DEEPGRAM_API_KEY || null;
  const transcriber = (env.TRANSCRIBER ??
    (production ? (deepgramApiKey ? 'deepgram' : 'twilio') : 'fake')) as string;
  if (transcriber !== 'deepgram' && transcriber !== 'twilio' && transcriber !== 'fake')
    throw new Error('TRANSCRIBER must be deepgram, twilio or fake');
  if (production && transcriber === 'fake')
    throw new Error('TRANSCRIBER=fake is for development and tests only');
  if (transcriber === 'deepgram' && !deepgramApiKey)
    throw new Error('DEEPGRAM_API_KEY is required with TRANSCRIBER=deepgram');

  const googleMapsServerKey = (env.GOOGLE_MAPS_SERVER_KEY ?? '').trim() || null;
  const geocoder = (env.GEOCODER ??
    (production ? (googleMapsServerKey ? 'google' : 'off') : 'fake')) as string;
  if (geocoder !== 'google' && geocoder !== 'fake' && geocoder !== 'off')
    throw new Error('GEOCODER must be google, fake or off');
  if (production && geocoder === 'fake')
    throw new Error('GEOCODER=fake is for development and tests only');
  if (geocoder === 'google' && !googleMapsServerKey)
    throw new Error('GOOGLE_MAPS_SERVER_KEY is required with GEOCODER=google');

  const voiceAgent = (env.VOICE_AGENT ??
    (production ? (deepgramApiKey ? 'deepgram' : 'off') : 'fake')) as string;
  if (voiceAgent !== 'deepgram' && voiceAgent !== 'fake' && voiceAgent !== 'off')
    throw new Error('VOICE_AGENT must be deepgram, fake or off');
  if (production && voiceAgent === 'fake')
    throw new Error('VOICE_AGENT=fake is for development and tests only');
  if (voiceAgent === 'deepgram' && !deepgramApiKey)
    throw new Error('DEEPGRAM_API_KEY is required with VOICE_AGENT=deepgram');

  // Branded domains (M17). `off` unless a token is there, because a business that adds a domain and then
  // waits forever for records that are never fetched is worse off than one that was never offered it.
  const vercelToken = env.VERCEL_TOKEN || null;
  const vercelProjectId = env.VERCEL_PROJECT_ID || null;
  const siteHost = (env.SITE_HOST ??
    (production ? (vercelToken ? 'vercel' : 'off') : 'fake')) as string;
  if (siteHost !== 'vercel' && siteHost !== 'fake' && siteHost !== 'off')
    throw new Error('SITE_HOST must be vercel, fake or off');
  if (production && siteHost === 'fake')
    throw new Error('SITE_HOST=fake is for development and tests only');
  if (siteHost === 'vercel' && !(vercelToken && vercelProjectId))
    throw new Error('VERCEL_TOKEN and VERCEL_PROJECT_ID are required with SITE_HOST=vercel');

  // Default `off`: a repo that starts charging the day it is deployed would be a nasty surprise, and every
  // step of the rollout is somebody deciding to take the next one.
  const walletMode = (env.WALLET_MODE ?? 'off') as string;
  if (walletMode !== 'off' && walletMode !== 'shadow' && walletMode !== 'on')
    throw new Error('WALLET_MODE must be off, shadow or on');

  const twilioAccountSid = env.TWILIO_ACCOUNT_SID || null;
  const twilioAuthToken = env.TWILIO_AUTH_TOKEN || null;
  if (telephonyProvider === 'twilio' && (!twilioAccountSid || !twilioAuthToken))
    throw new Error(
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required with TELEPHONY_PROVIDER=twilio',
    );

  const encryptionKey = env.WORKER_ENCRYPTION_KEY ?? '';
  if (!encryptionKey)
    throw new Error(
      'WORKER_ENCRYPTION_KEY is required (openssl rand -base64 32); `pnpm env:local` writes one',
    );

  const httpPort = Number(env.WORKER_HTTP_PORT ?? 4100);
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535)
    throw new Error(`Invalid WORKER_HTTP_PORT: ${env.WORKER_HTTP_PORT}`);
  const publicUrl = (env.WORKER_PUBLIC_URL ?? `http://127.0.0.1:${httpPort}`).replace(/\/+$/, '');

  /**
   * Support mail is told from a business's mail by the domain it was sent to, and nothing else. If the two
   * were ever the same, every customer's reply would become a support ticket, so this refuses to start.
   */
  const mailDomain = (env.MAIL_DOMAIN || 'mail.handsfreeos.com').toLowerCase();
  const supportMailDomain = (env.SUPPORT_MAIL_DOMAIN || 'handsfreeos.com').toLowerCase();
  if (supportMailDomain === mailDomain)
    throw new Error('SUPPORT_MAIL_DOMAIN must be a different domain from MAIL_DOMAIN');
  if (production && !/^https:\/\//.test(publicUrl))
    throw new Error('WORKER_PUBLIC_URL must be the https:// address providers call');

  const emailTransport = (env.EMAIL_TRANSPORT ?? (production ? 'postmark' : 'smtp')) as string;
  if (emailTransport !== 'postmark' && emailTransport !== 'smtp')
    throw new Error('EMAIL_TRANSPORT must be postmark or smtp');
  const postmarkServerToken = env.POSTMARK_SERVER_TOKEN || null;
  const postmarkAccountToken = env.POSTMARK_ACCOUNT_TOKEN || null;
  if (emailTransport === 'postmark' && (!postmarkServerToken || !postmarkAccountToken))
    throw new Error(
      'POSTMARK_SERVER_TOKEN and POSTMARK_ACCOUNT_TOKEN are required with EMAIL_TRANSPORT=postmark',
    );
  const postmarkWebhookPassword = env.POSTMARK_WEBHOOK_PASSWORD || '';
  if (production && postmarkWebhookPassword.length < 24)
    throw new Error('POSTMARK_WEBHOOK_PASSWORD must be a long random value (24+ characters)');

  const microsoftClientId = env.MICROSOFT_OAUTH_CLIENT_ID || null;
  const microsoftClientSecret = env.MICROSOFT_OAUTH_CLIENT_SECRET || null;
  const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID || null;
  const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || null;
  // Local development gets mailboxes that live in memory unless a real OAuth app is configured.
  const mailboxProvider = (env.MAILBOX_PROVIDER ??
    (production || microsoftClientId || googleClientId ? 'real' : 'fake')) as string;
  if (mailboxProvider !== 'real' && mailboxProvider !== 'fake')
    throw new Error('MAILBOX_PROVIDER must be real or fake');
  if (production && mailboxProvider === 'fake')
    throw new Error('MAILBOX_PROVIDER=fake is for development and tests only');
  const mailboxSyncMs = env.MAILBOX_SYNC_MS ? Number(env.MAILBOX_SYNC_MS) : null;

  const googleCalendarClientId = env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID || null;
  const googleCalendarClientSecret = env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET || null;
  // Local development gets calendars that live in memory unless a real OAuth app is configured (Outlook
  // calendars use the mailbox's Microsoft app).
  const calendarProvider = (env.CALENDAR_PROVIDER ??
    (production || microsoftClientId || googleCalendarClientId ? 'real' : 'fake')) as string;
  if (calendarProvider !== 'real' && calendarProvider !== 'fake')
    throw new Error('CALENDAR_PROVIDER must be real or fake');
  if (production && calendarProvider === 'fake')
    throw new Error('CALENDAR_PROVIDER=fake is for development and tests only');
  const calendarRefreshMs = Number(env.CALENDAR_REFRESH_MS || 600_000);
  if (!Number.isInteger(calendarRefreshMs) || calendarRefreshMs < 1_000)
    throw new Error('CALENDAR_REFRESH_MS must be a whole number of milliseconds, 1000 or more');

  // What customers said in public. Its own Google project again, so reviews can pass Google's review apart
  // from calendars and Gmail.
  const googleReviewClientId = env.GOOGLE_REVIEWS_OAUTH_CLIENT_ID || null;
  const googleReviewClientSecret = env.GOOGLE_REVIEWS_OAUTH_CLIENT_SECRET || null;
  const facebookAppId = env.FACEBOOK_APP_ID || null;
  const facebookAppSecret = env.FACEBOOK_APP_SECRET || null;
  const reviewProvider = (env.REVIEW_PROVIDER ??
    (production || googleReviewClientId || facebookAppId ? 'real' : 'fake')) as string;
  if (reviewProvider !== 'real' && reviewProvider !== 'fake')
    throw new Error('REVIEW_PROVIDER must be real or fake');
  if (production && reviewProvider === 'fake')
    throw new Error('REVIEW_PROVIDER=fake is for development and tests only');
  const reviewPollMs = Number(env.REVIEW_POLL_MS || 3_600_000);
  if (!Number.isInteger(reviewPollMs) || reviewPollMs < 1_000)
    throw new Error('REVIEW_POLL_MS must be a whole number of milliseconds, 1000 or more');

  // Facebook Messenger and Instagram: the reviews' Meta app, with a webhook of its own.
  const metaProvider = (env.META_PROVIDER ??
    (production || facebookAppId ? 'real' : 'fake')) as string;
  if (metaProvider !== 'real' && metaProvider !== 'fake')
    throw new Error('META_PROVIDER must be real or fake');
  if (production && metaProvider === 'fake')
    throw new Error('META_PROVIDER=fake is for development and tests only');
  const metaGraphVersion = (env.META_GRAPH_VERSION || 'v26.0').trim();
  if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(metaGraphVersion))
    throw new Error('META_GRAPH_VERSION must look like v26.0');
  const metaLoginConfigId = env.META_LOGIN_CONFIG_ID?.trim() || null;
  if (metaLoginConfigId && !/^[0-9]{1,40}$/.test(metaLoginConfigId))
    throw new Error(
      'META_LOGIN_CONFIG_ID must be the configuration’s number from Facebook Login for Business',
    );
  const metaHumanAgent = (env.META_HUMAN_AGENT ?? 'off').trim().toLowerCase();
  if (metaHumanAgent !== 'on' && metaHumanAgent !== 'off')
    throw new Error('META_HUMAN_AGENT must be on or off');
  const metaVerifyToken = env.META_WEBHOOK_VERIFY_TOKEN?.trim() || null;
  if (metaVerifyToken && metaVerifyToken.length < 16)
    throw new Error('META_WEBHOOK_VERIFY_TOKEN must be 16 characters or more');

  // Taking money. Local development gets the stand-in unless a real Stripe or Square app is configured.
  const stripeClientId = env.STRIPE_CLIENT_ID || null;
  const stripeSecretKey = env.STRIPE_SECRET_KEY || null;
  const squareApplicationId = env.SQUARE_APPLICATION_ID || null;
  const squareApplicationSecret = env.SQUARE_APPLICATION_SECRET || null;
  const paymentsProvider = (env.PAYMENTS_PROVIDER ??
    (production || stripeClientId || squareApplicationId ? 'real' : 'fake')) as string;
  if (paymentsProvider !== 'real' && paymentsProvider !== 'fake')
    throw new Error('PAYMENTS_PROVIDER must be real or fake');
  if (production && paymentsProvider === 'fake')
    throw new Error('PAYMENTS_PROVIDER=fake is for development and tests only');
  // A test key in production would take nobody's money and look like it had.
  if (production && stripeSecretKey && /^(sk|rk)_test_/.test(stripeSecretKey))
    throw new Error('STRIPE_SECRET_KEY is a test key; production needs the live one');
  if (stripeClientId && !stripeSecretKey)
    throw new Error('STRIPE_SECRET_KEY is required with STRIPE_CLIENT_ID');
  if (squareApplicationId && !squareApplicationSecret)
    throw new Error('SQUARE_APPLICATION_SECRET is required with SQUARE_APPLICATION_ID');
  const squareEnvironment = (env.SQUARE_ENVIRONMENT ?? (production ? 'live' : 'test')) as string;
  if (squareEnvironment !== 'live' && squareEnvironment !== 'test')
    throw new Error('SQUARE_ENVIRONMENT must be live or test');
  if (production && squareEnvironment === 'test')
    throw new Error('SQUARE_ENVIRONMENT=test is for development and tests only');
  const fakeSettleMs = env.PAYMENTS_FAKE_SETTLE_MS ? Number(env.PAYMENTS_FAKE_SETTLE_MS) : null;
  if (fakeSettleMs !== null && (!Number.isFinite(fakeSettleMs) || fakeSettleMs < 0))
    throw new Error('PAYMENTS_FAKE_SETTLE_MS must be a whole number of milliseconds');

  // Moving a business here from another CRM. Local development gets the stand-in agency unless a real
  // GoHighLevel app is configured, so a spec can migrate end to end with no account anywhere.
  // A server that only ever uses pasted private tokens (0069) has no client id to set, so it says
  // MIGRATION_SOURCE=real itself; production is real either way.
  const goHighLevelClientId = env.GOHIGHLEVEL_CLIENT_ID || null;
  const goHighLevelClientSecret = env.GOHIGHLEVEL_CLIENT_SECRET || null;
  const migrationSource = (env.MIGRATION_SOURCE ??
    (production || goHighLevelClientId ? 'real' : 'fake')) as string;
  if (migrationSource !== 'real' && migrationSource !== 'fake')
    throw new Error('MIGRATION_SOURCE must be real or fake');
  if (production && migrationSource === 'fake')
    throw new Error('MIGRATION_SOURCE=fake is for development and tests only');
  if (goHighLevelClientId && !goHighLevelClientSecret)
    throw new Error('GOHIGHLEVEL_CLIENT_SECRET is required with GOHIGHLEVEL_CLIENT_ID');

  const anthropicApiKey = env.ANTHROPIC_API_KEY || null;
  const assistantProvider = (env.ASSISTANT_PROVIDER ??
    (anthropicApiKey ? 'anthropic' : 'none')) as string;
  if (!['anthropic', 'scripted', 'none'].includes(assistantProvider))
    throw new Error('ASSISTANT_PROVIDER must be anthropic, scripted or none');
  if (production && assistantProvider === 'scripted')
    throw new Error('ASSISTANT_PROVIDER=scripted is for development and tests only');
  if (assistantProvider === 'anthropic' && !anthropicApiKey)
    throw new Error('ANTHROPIC_API_KEY is required with ASSISTANT_PROVIDER=anthropic');
  const assistantToolSearch = (env.ASSISTANT_TOOL_SEARCH || 'on') as string;
  if (!['on', 'off'].includes(assistantToolSearch))
    throw new Error('ASSISTANT_TOOL_SEARCH must be on or off');
  const assistantDailyTokens = Number(env.ASSISTANT_DAILY_TOKENS ?? 2_000_000);
  if (!Number.isInteger(assistantDailyTokens) || assistantDailyTokens < 1)
    throw new Error('ASSISTANT_DAILY_TOKENS must be a whole number above zero');
  const openAiApiKey = env.OPENAI_API_KEY?.trim() || null;
  const emails = (value: string | undefined) =>
    (value || '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.includes('@'));
  const aiAlertEmails = emails(env.AI_ALERT_EMAILS);

  const turnstileSecretKey = env.TURNSTILE_SECRET_KEY || null;
  // Cloudflare's always-pass test secret (booking/bot-check.ts) would let any bot book.
  if (production && turnstileSecretKey === '1x0000000000000000000000000000000AA')
    throw new Error('TURNSTILE_SECRET_KEY is Cloudflare’s test secret; use the real one');
  // Without it every public page lets bots through, so production says so out loud instead of quietly passing.
  if (production && !turnstileSecretKey && env.ALLOW_NO_BOT_CHECK !== '1')
    throw new Error(
      'TURNSTILE_SECRET_KEY is required in production (set ALLOW_NO_BOT_CHECK=1 to run without it on purpose)',
    );

  // Outside production a fixed key does (scripts/supabase-env.mjs writes it); production needs its own.
  const chatIpKey = env.CHAT_IP_KEY || (production ? '' : LOCAL_CHAT_IP_KEY);
  if (production && (chatIpKey.length < 32 || chatIpKey === LOCAL_CHAT_IP_KEY))
    throw new Error(
      'CHAT_IP_KEY must be a long random value (32+ characters): openssl rand -base64 32',
    );

  const fetchTestOrigins = list(env.FETCH_TEST_ORIGINS);
  if (production && fetchTestOrigins.length)
    throw new Error('FETCH_TEST_ORIGINS is for development and tests only');
  for (const origin of fetchTestOrigins) {
    let u: URL | null = null;
    try {
      u = new URL(origin);
    } catch {
      // Reported below.
    }
    if (!u || u.origin !== origin || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
      throw new Error(
        `FETCH_TEST_ORIGINS must list local origins like http://127.0.0.1:4190 (got ${origin})`,
      );
  }

  // Push: Expo with its access token (enhanced push security refuses sends without one). Production without a token
  // yet runs with push off rather than refusing to start; the phone app needs the Expo project first anyway.
  const expoAccessToken = env.EXPO_ACCESS_TOKEN?.trim() || null;
  const pushProvider = (env.PUSH_PROVIDER ??
    (production ? (expoAccessToken ? 'expo' : 'none') : 'fake')) as string;
  if (!['expo', 'fake', 'none'].includes(pushProvider))
    throw new Error('PUSH_PROVIDER must be expo, fake or none');
  if (production && pushProvider === 'fake')
    throw new Error('PUSH_PROVIDER=fake is for development and tests only');
  if (pushProvider === 'expo' && !expoAccessToken)
    throw new Error(
      'EXPO_ACCESS_TOKEN is required with PUSH_PROVIDER=expo (Expo → Access tokens, with enhanced push security on)',
    );
  // expo-server-sdk sends to EXPO_BASE_URL when it is set (Expo's own testing), access token and all.
  if (production && env.EXPO_BASE_URL)
    throw new Error(
      'EXPO_BASE_URL is for Expo’s own testing; production sends pushes only to Expo',
    );

  // The website's pixel carries the publishable `pk-` key, and it is the one most likely to be pasted here. It can
  // only write from a browser, so every report would be refused; said at deploy rather than in a log nobody reads.
  const opinlyApiKey = (env.OPINLY_API_KEY ?? '').trim() || null;
  if (opinlyApiKey && !opinlyApiKey.startsWith('sk-'))
    throw new Error(
      'OPINLY_API_KEY must be the secret sk- key from Opinly, not the pk- key the website uses',
    );

  const addonConnectors = (env.ADDON_CONNECTORS ?? (production ? 'real' : 'fake')) as string;
  if (addonConnectors !== 'real' && addonConnectors !== 'fake')
    throw new Error('ADDON_CONNECTORS must be real or fake');
  if (production && addonConnectors === 'fake')
    throw new Error('ADDON_CONNECTORS=fake is for development and tests only');
  const addonPlatformKeys = readAddonPlatformKeys(env.ADDON_PLATFORM_KEYS);

  const reminder = env.UNANSWERED_ALERT_MS ? Number(env.UNANSWERED_ALERT_MS) : null;
  return {
    databaseUrl,
    supabaseUrl,
    supabaseSecretKey,
    smtpUrl,
    mailFrom: env.MAIL_FROM ?? 'HandsFreeOS <hello@handsfreeos.local>',
    webUrl: (env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    pollMs: Number(env.WORKER_POLL_MS ?? 1000),
    batchSize: Number(env.WORKER_BATCH_SIZE ?? 20),
    logLevel: env.LOG_LEVEL ?? 'info',
    production,
    httpPort,
    httpHost: env.WORKER_HTTP_HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    webOrigins: list(env.WEB_ORIGINS ?? 'http://localhost:3000'),
    jwksUrl:
      env.SUPABASE_JWKS_URL ??
      (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : null),
    jwtIssuer: env.SUPABASE_JWT_ISSUER ?? (supabaseUrl ? `${supabaseUrl}/auth/v1` : null),
    migrationSource: migrationSource as 'real' | 'fake',
    goHighLevelClientId,
    goHighLevelClientSecret,
    telephonyProvider,
    transcriber: transcriber as 'deepgram' | 'twilio' | 'fake',
    siteHost: siteHost as 'vercel' | 'fake' | 'off',
    vercelToken,
    vercelProjectId,
    vercelTeamId: env.VERCEL_TEAM_ID || null,
    deepgramApiKey,
    geocoder: geocoder as 'google' | 'fake' | 'off',
    googleMapsServerKey,
    voiceAgent: voiceAgent as 'deepgram' | 'fake' | 'off',
    voiceModel: (env.VOICE_MODEL ?? '').trim() || null,
    walletMode: walletMode as 'off' | 'shadow' | 'on',
    twilioAccountSid,
    twilioAuthToken,
    twilioPrimaryProfileSid: env.TWILIO_PRIMARY_PROFILE_SID || null,
    encryptionKey,
    encryptionKeysPrevious: list(env.WORKER_ENCRYPTION_KEYS_PREVIOUS),
    reminderOverrideMs: reminder && Number.isFinite(reminder) && reminder > 0 ? reminder : null,
    registrationPollMs: Number(
      env.REGISTRATION_POLL_MS ?? (telephonyProvider === 'fake' ? 2_000 : 15 * 60_000),
    ),
    portPollMs: Number(
      env.PORT_POLL_MS ?? (telephonyProvider === 'fake' ? 2_000 : 6 * 60 * 60_000),
    ),
    // A transfer between Twilio accounts usually lands within a day or two of the request, and a business is
    // watching for it: every five minutes, slowing down on its own as the days go by (nextImportCheckMs).
    numberImportPollMs: Number(
      env.NUMBER_IMPORT_POLL_MS ?? (telephonyProvider === 'fake' ? 2_000 : 5 * 60_000),
    ),
    fakeApprovalMs: Number(env.FAKE_APPROVAL_MS ?? 3_000),
    emailTransport,
    postmarkServerToken,
    postmarkAccountToken,
    postmarkMessageStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
    postmarkBroadcastStream: env.POSTMARK_BROADCAST_STREAM?.trim() || null,
    postmarkWebhookUser: env.POSTMARK_WEBHOOK_USER || 'postmark',
    postmarkWebhookPassword: postmarkWebhookPassword || LOCAL_WEBHOOK_PASSWORD,
    mailDomain,
    supportMailDomain,
    supportAddresses: (env.SUPPORT_ADDRESSES || 'support,help')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
    supportFromName: env.SUPPORT_FROM_NAME || 'HandsFreeOS Support',
    platformOwnerEmails: emails(env.PLATFORM_OWNER_EMAILS),
    mailboxProvider,
    microsoftClientId,
    microsoftClientSecret,
    googleClientId,
    googleClientSecret,
    mailboxSyncMs:
      mailboxSyncMs && Number.isFinite(mailboxSyncMs) && mailboxSyncMs > 0 ? mailboxSyncMs : null,
    mailboxBackfillDays: Math.min(90, Math.max(1, Number(env.MAILBOX_BACKFILL_DAYS ?? 30) || 30)),
    calendarProvider,
    zoomClientId: env.ZOOM_OAUTH_CLIENT_ID || null,
    zoomClientSecret: env.ZOOM_OAUTH_CLIENT_SECRET || null,
    googleCalendarClientId,
    googleCalendarClientSecret,
    calendarRefreshMs,
    reviewProvider: reviewProvider as 'real' | 'fake',
    googleReviewClientId,
    googleReviewClientSecret,
    facebookAppId,
    facebookAppSecret,
    reviewPollMs,
    metaProvider: metaProvider as 'real' | 'fake',
    metaVerifyToken,
    metaLoginConfigId,
    metaGraphVersion,
    metaHumanAgent: metaHumanAgent === 'on',
    paymentsProvider,
    stripeClientId,
    stripeSecretKey,
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    stripePlatformWebhookSecret: env.STRIPE_PLATFORM_WEBHOOK_SECRET || null,
    opinlyApiKey,
    addonConnectors,
    addonPlatformKeys,
    squareApplicationId,
    squareApplicationSecret,
    squareWebhookSignatureKeys: list(env.SQUARE_WEBHOOK_SIGNATURE_KEYS),
    squareEnvironment,
    paymentsFakeSettleMs: fakeSettleMs,
    assistantProvider: assistantProvider as WorkerEnv['assistantProvider'],
    anthropicApiKey,
    assistantModel: env.ASSISTANT_MODEL || 'claude-opus-5-5',
    aiModel: env.AI_MODEL || 'claude-sonnet-5',
    assistantToolSearch: assistantToolSearch === 'on',
    assistantDailyTokens,
    openAiApiKey,
    openAiModel: env.OPENAI_MODEL?.trim() || 'gpt-6-sol',
    openAiAssistantModel: env.OPENAI_ASSISTANT_MODEL?.trim() || 'gpt-6-sol',
    openAiVoiceModel: env.OPENAI_VOICE_MODEL?.trim() || 'gpt-6-luna',
    aiAlertEmails: aiAlertEmails.length ? aiAlertEmails : emails(env.PLATFORM_OWNER_EMAILS),
    turnstileSecretKey,
    bookingRateLimitFactor: production ? 1 : 10,
    chatIpKey,
    fetchTestOrigins,
    pushProvider: pushProvider as WorkerEnv['pushProvider'],
    expoAccessToken,
  };
}

/**
 * ADDON_PLATFORM_KEYS: `{"realestate.repliers": {"apiKey": "…"}}`. Said at deploy when it's the wrong shape, rather
 * than when a business first needs it.
 */
function readAddonPlatformKeys(
  raw: string | undefined,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (!raw?.trim()) return {};
  const wrong = () =>
    new Error(
      'ADDON_PLATFORM_KEYS must be a JSON object like {"realestate.repliers": {"apiKey": "…"}}: each name is ' +
        '<add-on>.<service>, and each value an object of text fields',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw wrong();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw wrong();
  const out: Record<string, Record<string, string>> = {};
  for (const [name, fields] of Object.entries(parsed)) {
    if (!/^[a-z]{2,16}\.[a-z][a-z0-9_]{0,39}$/.test(name)) throw wrong();
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw wrong();
    const entries = Object.entries(fields as Record<string, unknown>);
    if (!entries.length || entries.some(([, v]) => typeof v !== 'string' || !v.trim()))
      throw wrong();
    out[name] = Object.fromEntries(entries.map(([k, v]) => [k, (v as string).trim()]));
  }
  return out;
}
