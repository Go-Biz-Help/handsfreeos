import { hostname } from 'node:os';
import { createDb } from '@hfos/db/client';
import pino from 'pino';
import { loadEnv, readEnv } from './env';
import { handlers } from './handlers/index';
import { createSmtpMailer } from './mailer';
import { processOnce } from './outbox';

loadEnv();
const env = readEnv();
const log = pino(
  process.env.NODE_ENV === 'production'
    ? { level: env.logLevel }
    : { level: env.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
);

const handle = createDb(env.databaseUrl, { max: 4, applicationName: 'hfos-worker' });
const deps = {
  db: handle.db,
  mailer: createSmtpMailer(env.smtpUrl, env.mailFrom),
  log,
  handlers,
  webUrl: env.webUrl,
  workerId: `${hostname()}:${process.pid}`,
  batchSize: env.batchSize,
};

let running = true;
let inFlight: Promise<void> = Promise.resolve();

log.info({ pollMs: env.pollMs, handlers: Object.keys(handlers) }, 'worker started');

const tick = async () => {
  try {
    const stats = await processOnce(deps);
    if (stats.claimed > 0) log.info(stats, 'outbox pass');
  } catch (e) {
    log.error({ err: e }, 'outbox pass crashed');
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
  log.info({ signal }, 'worker stopping after the current pass');
  await inFlight;
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
