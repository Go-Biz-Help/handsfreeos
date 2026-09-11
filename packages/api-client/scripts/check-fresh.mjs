// CI guard: the committed schema must match a fresh generation.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const before = readFileSync('src/schema.d.ts', 'utf8');
execSync('pnpm generate', { stdio: 'inherit' });
const after = readFileSync('src/schema.d.ts', 'utf8');
if (before !== after) {
  console.error(
    'packages/api-client/src/schema.d.ts is stale. Run `pnpm openapi` and commit the result.',
  );
  process.exit(1);
}
console.log('api-client schema is fresh');
