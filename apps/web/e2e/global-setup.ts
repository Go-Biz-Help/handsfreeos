import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const WORKER_URL = (process.env.WORKER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');

/**
 * Invitations, texting and reminders need the worker (it emails links, plays the fake carrier and answers
 * its webhooks), and the Assistant specs need it answering from the scripted stand-in model. Start one for
 * the run in its own process group so teardown stops the tsx child too, not just the pnpm wrapper. A dev
 * worker already listening on the port keeps serving instead (without the short reminder window or the
 * scripted model below, so the reminder and Assistant specs expect this one).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const startedAt = new Date().toISOString();
  const root = resolve(process.cwd(), '../..');
  const worker: ChildProcess = spawn(
    'pnpm',
    ['--filter', '@hfos/worker', 'exec', 'tsx', 'src/main.ts'],
    {
      cwd: root,
      env: {
        ...process.env,
        LOG_LEVEL: 'warn',
        WORKER_POLL_MS: '500',
        // The unanswered-message email after 8 seconds instead of the workspace's 10 minutes.
        UNANSWERED_ALERT_MS: '8000',
        // The Assistant answers from the scripted stand-in model, never a real provider. The empty key also wins
        // over any key in apps/worker/.env: the worker's .env never replaces what is already set.
        ASSISTANT_PROVIDER: 'scripted',
        ANTHROPIC_API_KEY: '',
      },
      stdio: 'ignore',
      detached: true,
    },
  );

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${WORKER_URL}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`the worker did not answer at ${WORKER_URL}/healthz`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // The core, DB and worker suites leave thousands of pending events and due jobs in the shared local database,
  // and the worker would spend minutes on them before reaching the specs' own (a texting spec's registration poll
  // timed out behind 1,700 old jobs). Skip the ones written before this run started (never the run's own). A reused
  // dev worker without the test routes just keeps its backlog.
  for (const [route, what] of [
    ['/test/outbox/skip-stale', 'outbox events'],
    ['/test/scheduled-jobs/skip-stale', 'scheduled jobs'],
  ] as const) {
    try {
      const res = await fetch(`${WORKER_URL}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ before: startedAt }),
      });
      if (!res.ok) console.warn(`Old ${what} weren’t skipped (${res.status}).`);
    } catch {
      console.warn(`Old ${what} weren’t skipped: the worker didn’t answer.`);
    }
  }

  return async () => {
    if (worker.pid) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        worker.kill('SIGTERM');
      }
    }
  };
}
