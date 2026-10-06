import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads `.env` from the app directory when present. Never throws when the file is missing. */
export function loadEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

export interface ApiEnv {
  readonly port: number;
  readonly host: string;
  readonly webOrigins: readonly string[];
  readonly logLevel: string;
  readonly supabaseUrl: string;
  readonly jwtIssuer: string;
  readonly jwksUrl: string;
  readonly databaseUrl: string;
  readonly trustProxy: boolean;
  /**
   * Serve the OpenAPI document and its browsable docs (/openapi.json, /docs): everywhere but production, where
   * they would list every operation, staff ones included, to anyone who asks.
   */
  readonly serveDocs: boolean;
  /**
   * The oldest phone app build the API still takes (`MIN_APP_VERSION`, like "1.4.0"): an older one is told to update
   * (426) and keeps its unsent changes. Unset, every build is taken.
   */
  readonly minAppVersion: string | null;
  /**
   * The oldest browser extension build the API still takes (`MIN_EXTENSION_VERSION`, like "0.2.0"): an older one is
   * told to update (426). Unset, every build is taken.
   */
  readonly minExtensionVersion: string | null;
}

// Secret-looking names anywhere; provider credentials by the prefixes our config uses; any OAuth client setting
// (a name containing _OAUTH_, like GOOGLE_CALENDAR_OAUTH_CLIENT_ID); Turnstile's keys; and the key the
// website chat hashes visitors' IP addresses with. Claude Code's own CLAUDE_CODE_*OAUTH* names in a
// developer's shell are left alone.
//
// The payment providers are named by prefix, not by what looks secret: STRIPE_CLIENT_ID and
// SQUARE_APPLICATION_ID would sail through every other rule here, and an API process that holds a Connect
// client id is one env file away from holding the key beside it. All five providers are listed now, including
// the three that are only on the roadmap, so the guard is already in place when they land.
//
// Expo's by prefix too (M10): the worker alone holds EXPO_ACCESS_TOKEN, which every push must carry, and EAS's
// EXPO_TOKEN can build and publish the app. EXPO_PUBLIC_* names are left alone: Expo writes those into the phone
// app itself, so they are public by design, and a shell set up for the app may have them.
//
// ADDON_PLATFORM_KEYS (round five) holds HandsFreeOS's own accounts at the services add-ons connect to (Repliers):
// the worker's alone, like every other provider key.
//
// Meta (20261025000200): FACEBOOK_APP_SECRET is caught by SECRET, and META_WEBHOOK_VERIFY_TOKEN is what Meta's
// webhook setup checks the worker with, so it's the worker's alone too.
const FORBIDDEN =
  /SECRET|SERVICE_ROLE|SIGNING_KEY|ENCRYPTION_KEY|^ADDON_PLATFORM_KEYS$|^TWILIO_|^POSTMARK_|^META_WEBHOOK_|^TURNSTILE_|^(?!CLAUDE_CODE_).*_OAUTH_|^(ANTHROPIC|OPENAI|DEEPGRAM)_|^CHAT_IP_KEY$|^GOOGLE_MAPS_SERVER_KEY$|^STRIPE_|^SQUARE_|^PAYMENTS_|^PAYPAL_|^NMI_|^AUTHORIZE_NET_|^EXPO_(?!PUBLIC_)/i;

/** Reads and validates the API process environment. Refuses to boot with privileged keys present. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const leaked = Object.keys(env).filter((k) => FORBIDDEN.test(k));
  if (leaked.length > 0) {
    throw new Error(
      `The API process must never hold privileged keys. Remove: ${leaked.join(', ')}`,
    );
  }
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid PORT: ${env.PORT}`);
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(supabaseUrl))
    throw new Error('SUPABASE_URL must be set to the Supabase API URL');
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error('DATABASE_URL must be a postgres:// URL for the hfos_api role');
  if (/\/\/postgres[:@]/.test(databaseUrl))
    throw new Error('DATABASE_URL must not connect as the postgres role');
  const minAppVersion = env.MIN_APP_VERSION?.trim() || null;
  if (minAppVersion && !/^\d+(\.\d+){0,2}$/.test(minAppVersion))
    throw new Error(`MIN_APP_VERSION must be a build number like 1.4.0, not ${minAppVersion}`);
  const minExtensionVersion = env.MIN_EXTENSION_VERSION?.trim() || null;
  if (minExtensionVersion && !/^\d+(\.\d+){0,2}$/.test(minExtensionVersion))
    throw new Error(
      `MIN_EXTENSION_VERSION must be a build number like 0.2.0, not ${minExtensionVersion}`,
    );
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL ?? 'info',
    supabaseUrl,
    jwtIssuer: env.SUPABASE_JWT_ISSUER ?? `${supabaseUrl}/auth/v1`,
    jwksUrl: env.SUPABASE_JWKS_URL ?? `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    databaseUrl,
    trustProxy: env.TRUST_PROXY === 'true',
    serveDocs: env.NODE_ENV !== 'production',
    minAppVersion,
    minExtensionVersion,
  };
}
