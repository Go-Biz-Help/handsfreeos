import { defineConfig } from 'tsup';

export default defineConfig({
  // The worker, and the media process that hears video calls (fly.toml `[processes]`).
  entry: ['src/main.ts', 'src/media.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@hfos\//],
});
