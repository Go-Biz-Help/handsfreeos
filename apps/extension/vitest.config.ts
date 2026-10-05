import { defineConfig } from 'vitest/config';

// The readers take a page's nodes, so the tests build each saved page with jsdom themselves.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
