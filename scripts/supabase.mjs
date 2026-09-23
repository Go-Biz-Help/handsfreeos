#!/usr/bin/env node
/**
 * Runs the Supabase CLI with the conveniences this repo needs. Usage: node scripts/supabase.mjs <args...>
 *   - points Docker at Colima when that is the Docker on this machine and DOCKER_HOST is unset
 *   - on `start`: creates .env from .env.example when missing (config.toml reads env() values from it)
 *     and generates the gitignored ES256 signing key the local Auth server signs tokens with
 *   - on `start`: tries again after a pause when an image download fails (see `start` below)
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };
const colimaSock = join(homedir(), '.colima/default/docker.sock');
if (!env.DOCKER_HOST && existsSync(colimaSock)) env.DOCKER_HOST = `unix://${colimaSock}`;

function reportSpawnError(error) {
  console.error(
    error.code === 'ENOENT'
      ? 'The Supabase CLI is not installed. Install it with: brew install supabase/tap/supabase'
      : error.message,
  );
}

function run(args) {
  const r = spawnSync('supabase', args, { cwd: root, env, stdio: 'inherit' });
  if (r.error) {
    reportSpawnError(r.error);
    return 1;
  }
  return r.status ?? 1;
}

/**
 * Like `run`, but also keeps the end of what the CLI printed. Only output that isn't going to a terminal is read,
 * so the CLI sees exactly the streams it always did and keeps its progress bars and colours in a terminal.
 */
function runReading(args) {
  return new Promise((resolve) => {
    const read = (stream) => (stream.isTTY ? 'inherit' : 'pipe');
    const child = spawn('supabase', args, {
      cwd: root,
      env,
      stdio: ['inherit', read(process.stdout), read(process.stderr)],
    });
    let tail = '';
    const passOn = (to) => (chunk) => {
      to.write(chunk);
      tail = (tail + chunk).slice(-65536);
    };
    child.stdout?.on('data', passOn(process.stdout));
    child.stderr?.on('data', passOn(process.stderr));
    child.on('error', (error) => {
      reportSpawnError(error);
      resolve({ status: 1, tail });
    });
    child.on('close', (status) => resolve({ status: status ?? 1, tail }));
  });
}

/**
 * `supabase start` downloads every image the stack needs before it starts any of them, and a registry can refuse
 * downloads for a long time: on 2026-09-23 ghcr.io answered `toomanyrequests` to every CI run for over an hour, and
 * the CLI's own three tries came microseconds apart, so the job failed before lint or a single test had run. So when
 * the CLI fails saying an image didn't download, stop whatever did start and try again a minute later, up to ten
 * times. Any other failure, a broken migration or a port in use, ends it at once as before.
 *
 * Many short tries beat a few long waits. Docker keeps every layer that did arrive, so each try picks up where the
 * last one stopped, and ghcr.io counts its limit per minute. That day, four tries 1, 2 and 4 minutes apart finished
 * six of the eight images; the 2- and 4-minute waits got no further than the 1-minute one.
 *
 * Telling a download failure from the rest means reading the CLI's output, which happens in CI and wherever else it
 * is piped. In a terminal nothing is read and nothing is retried: the person watching sees it fail and runs it again.
 */
const PULL_FAILED = /failed to pull docker image/i;
const TRIES = 10;
const PAUSE_SECONDS = 60;

async function start(args) {
  for (let attempt = 1; ; attempt++) {
    const { status, tail } = await runReading(args);
    if (status === 0 || attempt === TRIES || !PULL_FAILED.test(tail)) return status;
    const message = `A Supabase image didn't download (try ${attempt} of ${TRIES}), so trying again in ${PAUSE_SECONDS} s.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : message);
    // A runner is thrown away afterwards, so it starts again from nothing; a laptop keeps its local database.
    run(process.env.CI ? ['stop', '--no-backup'] : ['stop']);
    await sleep(PAUSE_SECONDS * 1000);
  }
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
  process.exit(await start(args));
}
process.exit(run(args));
