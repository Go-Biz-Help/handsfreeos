import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const databaseUrl = env.DATABASE_URL_WORKER ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error('DATABASE_URL_WORKER must be a postgres:// URL for the hfos_worker role');
  if (/\/\/postgres[:@]/.test(databaseUrl))
    throw new Error('DATABASE_URL_WORKER must not connect as the postgres role');
  const smtpUrl = env.SMTP_URL ?? '';
  if (!/^smtps?:\/\//.test(smtpUrl)) throw new Error('SMTP_URL must be an smtp:// or smtps:// URL');
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '') || null;
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY || null;
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
  };
}
