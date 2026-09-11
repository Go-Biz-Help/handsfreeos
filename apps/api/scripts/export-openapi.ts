/** Writes the API's OpenAPI document to packages/api-client/openapi.json (no server, no database needed). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/app';
import { readEnv } from '../src/env';

const env = readEnv({
  PORT: '0',
  SUPABASE_URL: 'http://127.0.0.1:54421',
  DATABASE_URL: 'postgresql://hfos_api:unused@127.0.0.1:54422/postgres',
  WEB_ORIGINS: 'http://localhost:3000',
});
const app = await buildApp({ env, logger: false });
await app.ready();
const doc = app.swagger();
const out = resolve(process.cwd(), '../../packages/api-client/openapi.json');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
await app.close();
console.log(`wrote ${out} (${Object.keys((doc as { paths: object }).paths).length} paths)`);
