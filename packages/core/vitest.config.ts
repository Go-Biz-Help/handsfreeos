import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
