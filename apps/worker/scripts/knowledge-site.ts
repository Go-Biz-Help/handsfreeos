/**
 * Serves the knowledge base's stand-in website (apps/worker/fixtures/knowledge-site) for Playwright, exactly as
 * the worker tests do: `pnpm --filter @hfos/worker knowledge-site [port]` (or PORT; default 4190). Give the
 * worker FETCH_TEST_ORIGINS=http://127.0.0.1:<port> (outside production, with the fake carrier) so a scan may
 * reach it.
 */
import { startFixtureSite } from '../fixtures/knowledge-site/server';

const port = Number(process.argv[2] ?? process.env.PORT ?? 4190);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error(`Invalid port: ${process.argv[2] ?? process.env.PORT}`);

const site = await startFixtureSite({ port });
console.log(`Knowledge fixture site at ${site.origin}`);

const stop = async () => {
  await site.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
