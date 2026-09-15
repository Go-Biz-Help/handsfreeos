import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// The test helpers need the local stack's addresses from .env.local. Privileged keys stay out of
// process.env on purpose: Playwright hands its environment to the servers it starts and the API
// refuses to boot with one (the worker reads its own apps/worker/.env).
// The same list as the API's env guard (apps/api/src/env.ts).
const PRIVILEGED =
  /SECRET|SERVICE_ROLE|SIGNING_KEY|ENCRYPTION_KEY|^TWILIO_|^POSTMARK_|^TURNSTILE_|^(?!CLAUDE_CODE_).*_OAUTH_|^(ANTHROPIC|OPENAI)_|^CHAT_IP_KEY$/i;
for (const c of ['../../.env.local', '.env.local']) {
  const p = resolve(process.cwd(), c);
  if (!existsSync(p)) continue;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(p, 'utf8')))) {
    if (!PRIVILEGED.test(k) && process.env[k] === undefined) process.env[k] = v;
  }
}

// The servers Playwright starts inherit this process's environment (a server's own `env` can only add to it),
// so privileged names this shell carries, like ANTHROPIC_BASE_URL, are removed here or the API refuses to boot.
for (const k of Object.keys(process.env)) if (PRIVILEGED.test(k)) delete process.env[k];

// The knowledge base's stand-in website (apps/worker/fixtures/knowledge-site), served below. The worker the global
// setup starts may scan only these local origins (outside production, with the fake carrier). Not a secret.
const KNOWLEDGE_SITE = 'http://127.0.0.1:4190';
process.env.FETCH_TEST_ORIGINS ??= KNOWLEDGE_SITE;

// The stand-in business websites the website chat specs paste the snippet on (e2e/fixtures/chat-site.mjs): the
// widget allows the first, and the browser refuses to show the chat window on the second.
const CHAT_SITES = ['http://127.0.0.1:4191', 'http://127.0.0.1:4192'];
// The web server's widget lookups aren't kept, so a pause or a new key shows at once (CI serves the production build).
process.env.CHAT_LOOKUP_CACHE_MS ??= '0';

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
      testIgnore: /.*mobile\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 832 } },
    },
    {
      // Phone-sized Chromium with touch: the specs named *.mobile.spec.ts cover the phone shell and board.
      name: 'mobile',
      testMatch: /.*mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
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
    {
      // The stand-in website the knowledge spec scans (through the worker's /test/knowledge/scan-at).
      command: `pnpm --filter @hfos/worker knowledge-site ${new URL(KNOWLEDGE_SITE).port}`,
      url: `${KNOWLEDGE_SITE}/robots.txt`,
      cwd: resolve(process.cwd(), '../..'),
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    ...CHAT_SITES.map((site) => ({
      command: `node e2e/fixtures/chat-site.mjs ${new URL(site).port}`,
      url: `${site}/healthz`,
      reuseExistingServer: !CI,
      timeout: 30_000,
    })),
  ],
});
