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
const FORBIDDEN =
  /SECRET|SERVICE_ROLE|SIGNING_KEY|ENCRYPTION_KEY|^TWILIO_|^POSTMARK_|^TURNSTILE_|^(?!CLAUDE_CODE_).*_OAUTH_|^(ANTHROPIC|OPENAI)_|^CHAT_IP_KEY$|^STRIPE_|^SQUARE_|^PAYMENTS_|^PAYPAL_|^NMI_|^AUTHORIZE_NET_/i;

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
  };
}
