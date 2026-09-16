import { defineConfig } from 'vitest/config';

// The sync scenarios need the local Supabase stack and the local PowerSync Service (`pnpm sync:start`); CI runs them
// in .github/workflows/sync.yml. Files run one at a time: they share one service and each makes its own business.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 120_000,
  },
});
