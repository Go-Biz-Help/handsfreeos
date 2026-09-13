import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_WEBHOOK_PASSWORD } from './email/local';

export function loadEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (existsSync(path)) process.loadEnvFile(path);
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
  readonly twilioAccountSid: string | null;
  readonly twilioAuthToken: string | null;
  /** HandsFreeOS's approved ISV customer profile (BU...): local (10DLC) registrations link under it. */
  readonly twilioPrimaryProfileSid: string | null;
  readonly encryptionKey: string;
  readonly encryptionKeysPrevious: readonly string[];
  /** Local demos and tests shorten the reply reminder (milliseconds); production uses workspace settings. */
  readonly reminderOverrideMs: number | null;
  readonly registrationPollMs: number;
  readonly fakeApprovalMs: number;
  /** Workspace email: Postmark in production; locally Mailpit over SMTP, with domains that verify themselves. */
  readonly emailTransport: 'postmark' | 'smtp';
  readonly postmarkServerToken: string | null;
  /** The Domains API (workspaces' own domains) needs the account token. */
  readonly postmarkAccountToken: string | null;
  readonly postmarkMessageStream: string;
  /** Basic auth on Postmark's webhooks (Postmark signs nothing). */
  readonly postmarkWebhookUser: string;
  readonly postmarkWebhookPassword: string;
  /** The shared subdomain (mirrors private.shared_mail_domain()). */
  readonly mailDomain: string;
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
  /** The Assistant: Claude, a scripted stand-in for tests, or none (the panel says it isn't set up). */
  readonly assistantProvider: 'anthropic' | 'scripted' | 'none';
  readonly anthropicApiKey: string | null;
  readonly assistantModel: string;
  /** Tokens one workspace's Assistant may use per day, cache reads and writes included. */
  readonly assistantDailyTokens: number;
  /** Cloudflare Turnstile on the public booking page (its site key lives on the web); unset: no bot check. */
  readonly turnstileSecretKey: string | null;
  /**
   * Multiplies the booking page's per-address limits: 1 in production, 10 elsewhere, because local
   * development and Playwright book from one address.
   */
  readonly bookingRateLimitFactor: number;
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
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY || null;

  const telephonyProvider = (env.TELEPHONY_PROVIDER ?? (production ? 'twilio' : 'fake')) as string;
  if (telephonyProvider !== 'twilio' && telephonyProvider !== 'fake')
    throw new Error('TELEPHONY_PROVIDER must be twilio or fake');
  if (production && telephonyProvider === 'fake')
    throw new Error('TELEPHONY_PROVIDER=fake is for development and tests only');
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

  const anthropicApiKey = env.ANTHROPIC_API_KEY || null;
  const assistantProvider = (env.ASSISTANT_PROVIDER ??
    (anthropicApiKey ? 'anthropic' : 'none')) as string;
  if (!['anthropic', 'scripted', 'none'].includes(assistantProvider))
    throw new Error('ASSISTANT_PROVIDER must be anthropic, scripted or none');
  if (production && assistantProvider === 'scripted')
    throw new Error('ASSISTANT_PROVIDER=scripted is for development and tests only');
  if (assistantProvider === 'anthropic' && !anthropicApiKey)
    throw new Error('ANTHROPIC_API_KEY is required with ASSISTANT_PROVIDER=anthropic');
  const assistantDailyTokens = Number(env.ASSISTANT_DAILY_TOKENS ?? 2_000_000);
  if (!Number.isInteger(assistantDailyTokens) || assistantDailyTokens < 1)
    throw new Error('ASSISTANT_DAILY_TOKENS must be a whole number above zero');

  const turnstileSecretKey = env.TURNSTILE_SECRET_KEY || null;
  // Cloudflare's always-pass test secret (booking/bot-check.ts) would let any bot book.
  if (production && turnstileSecretKey === '1x0000000000000000000000000000000AA')
    throw new Error('TURNSTILE_SECRET_KEY is Cloudflare’s test secret; use the real one');

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
    telephonyProvider,
    twilioAccountSid,
    twilioAuthToken,
    twilioPrimaryProfileSid: env.TWILIO_PRIMARY_PROFILE_SID || null,
    encryptionKey,
    encryptionKeysPrevious: list(env.WORKER_ENCRYPTION_KEYS_PREVIOUS),
    reminderOverrideMs: reminder && Number.isFinite(reminder) && reminder > 0 ? reminder : null,
    registrationPollMs: Number(
      env.REGISTRATION_POLL_MS ?? (telephonyProvider === 'fake' ? 2_000 : 15 * 60_000),
    ),
    fakeApprovalMs: Number(env.FAKE_APPROVAL_MS ?? 3_000),
    emailTransport,
    postmarkServerToken,
    postmarkAccountToken,
    postmarkMessageStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
    postmarkWebhookUser: env.POSTMARK_WEBHOOK_USER || 'postmark',
    postmarkWebhookPassword: postmarkWebhookPassword || LOCAL_WEBHOOK_PASSWORD,
    mailDomain: (env.MAIL_DOMAIN || 'mail.handsfreeos.com').toLowerCase(),
    mailboxProvider,
    microsoftClientId,
    microsoftClientSecret,
    googleClientId,
    googleClientSecret,
    mailboxSyncMs:
      mailboxSyncMs && Number.isFinite(mailboxSyncMs) && mailboxSyncMs > 0 ? mailboxSyncMs : null,
    mailboxBackfillDays: Math.min(90, Math.max(1, Number(env.MAILBOX_BACKFILL_DAYS ?? 30) || 30)),
    calendarProvider,
    googleCalendarClientId,
    googleCalendarClientSecret,
    calendarRefreshMs,
    assistantProvider: assistantProvider as WorkerEnv['assistantProvider'],
    anthropicApiKey,
    assistantModel: env.ASSISTANT_MODEL || 'claude-sonnet-5',
    assistantDailyTokens,
    turnstileSecretKey,
    bookingRateLimitFactor: production ? 1 : 10,
  };
}
