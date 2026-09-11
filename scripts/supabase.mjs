#!/usr/bin/env node
/**
 * Runs the Supabase CLI with the conveniences this repo needs. Usage: node scripts/supabase.mjs <args...>
 *   - points Docker at Colima when that is the Docker on this machine and DOCKER_HOST is unset
 *   - on `start`: creates .env from .env.example when missing (config.toml reads env() values from it)
 *     and generates the gitignored ES256 signing key the local Auth server signs tokens with
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };
const colimaSock = join(homedir(), '.colima/default/docker.sock');
if (!env.DOCKER_HOST && existsSync(colimaSock)) env.DOCKER_HOST = `unix://${colimaSock}`;

function run(args) {
  const r = spawnSync('supabase', args, { cwd: root, env, stdio: 'inherit' });
  if (r.error) {
    console.error(
      r.error.code === 'ENOENT'
        ? 'The Supabase CLI is not installed. Install it with: brew install supabase/tap/supabase'
        : r.error.message,
    );
    return 1;
  }
  return r.status ?? 1;
}

const args = process.argv.slice(2);
if (args[0] === 'start') {
  const envFile = join(root, '.env');
  const example = join(root, '.env.example');
  if (!existsSync(envFile) && existsSync(example)) {
    copyFileSync(example, envFile);
    console.log(
      'Created .env from .env.example (Google OAuth values stay empty until you fill them in).',
    );
  }
  const keys = join(root, 'supabase/signing_keys.json');
  if (!existsSync(keys)) {
    console.log('Generating a local ES256 signing key: supabase/signing_keys.json (gitignored).');
    writeFileSync(keys, '[]\n');
    const status = run(['gen', 'signing-key', '--algorithm', 'ES256', '--append']);
    if (status !== 0) process.exit(status);
  }
}
process.exit(run(args));
