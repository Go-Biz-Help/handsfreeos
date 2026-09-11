import { buildApp } from './app';
import { loadEnv, readEnv } from './env';

loadEnv();
const env = readEnv();

const app = await buildApp({
  env,
  logger:
    process.env.NODE_ENV === 'production'
      ? { level: env.logLevel }
      : { level: env.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.port, host: env.host });
app.log.info(`OpenAPI at http://${env.host}:${env.port}/docs`);
