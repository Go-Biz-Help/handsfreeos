import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// The test helpers need the local stack's addresses from .env.local. Privileged keys stay out of
// process.env on purpose: Playwright hands its environment to the servers it starts and the API
// refuses to boot with one (the worker reads its own apps/worker/.env).
const PRIVILEGED = /SECRET|SERVICE_ROLE|SIGNING_KEY/i;
for (const c of ['../../.env.local', '.env.local']) {
  const p = resolve(process.cwd(), c);
  if (!existsSync(p)) continue;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(p, 'utf8')))) {
    if (!PRIVILEGED.test(k) && process.env[k] === undefined) process.env[k] = v;
  }
}

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 832 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @hfos/api exec tsx src/server.ts',
      url: 'http://127.0.0.1:4000/healthz',
      cwd: resolve(process.cwd(), '../..'),
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      // CI serves the production build (built by the workflow first); locally the dev server is reused.
      command: CI ? 'pnpm --filter @hfos/web start' : 'pnpm --filter @hfos/web dev',
      url: 'http://localhost:3000/sign-in',
      cwd: resolve(process.cwd(), '../..'),
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
