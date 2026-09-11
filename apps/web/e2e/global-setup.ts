import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The invitation flow needs the worker (it mints and emails the link). Start one for the run in its own
 * process group so teardown stops the tsx child too, not just the pnpm wrapper.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = resolve(process.cwd(), '../..');
  const worker: ChildProcess = spawn(
    'pnpm',
    ['--filter', '@hfos/worker', 'exec', 'tsx', 'src/main.ts'],
    {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: 'warn', WORKER_POLL_MS: '500' },
      stdio: 'ignore',
      detached: true,
    },
  );
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
