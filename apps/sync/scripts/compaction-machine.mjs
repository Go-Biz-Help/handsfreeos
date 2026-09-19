#!/usr/bin/env node
/**
 * Keeps the sync service's daily compaction machine in step with the service. The Deploy workflow runs it after each
 * sync deploy; by hand, from the repository root: `node apps/sync/scripts/compaction-machine.mjs` (flyctl signed in).
 *
 * PowerSync only ever appends to its buckets. Its `compact` command folds each bucket's history, so a phone's first
 * copy downloads less and the storage Postgres stays small. It has to run on a machine of its own: inside the
 * service's, both want port 8080 (spike 1b). So handsfreeos-sync has a second machine, "compact", that Fly starts
 * about once a day (a scheduled machine): it runs `compact` with the service's image, settings and files, then stops.
 * Fly's deploys never touch machines they didn't make, so this script compares that machine with the service's
 * machine and the files in this checkout, and replaces it when anything differs. Secrets reach it like any machine of
 * the app.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.HFOS_SYNC_APP ?? 'handsfreeos-sync';
const local = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
/** The same files fly.toml writes into the service's machine. */
const FILES = {
  '/config/service.yaml': local('service.yaml'),
  '/config/sync-config.yaml': local('sync-config.yaml'),
  '/config/status.mjs': local('scripts/status.mjs'),
};

const fly = (args) =>
  execFileSync('flyctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const machines = JSON.parse(fly(['machine', 'list', '--app', APP, '--json']) || '[]');
const service = machines.find((m) => m.config?.metadata?.fly_process_group === 'app');
if (!service) {
  console.error(`${APP} has no service machine yet. Deploy the sync service first.`);
  process.exit(1);
}

// Fly's own variables (FLY_*, PRIMARY_REGION) are set on every machine by Fly itself.
const env = Object.fromEntries(
  Object.entries(service.config.env ?? {}).filter(
    ([name]) => !name.startsWith('FLY_') && name !== 'PRIMARY_REGION',
  ),
);
/**
 * The image to launch the compaction machine with. It has to be a tag, not a digest: `flyctl machine run` (v0.4.104)
 * appends the resolved digest to whatever ref it is given, so a ref that already carries one becomes
 * `repo@sha256:x@sha256:x` and Fly answers `config.image: invalid image identifier`. The service's machine records
 * the image's version as an OCI label, so the tag is rebuilt from that and stays in step with the service by itself.
 * The fingerprint below still uses the service's exact digest, so a changed image still replaces the machine. When
 * flyctl takes a digest again, this can go back to `service.config.image`.
 */
const launchImage = () => {
  const ref = service.image_ref;
  const version = ref?.labels?.['org.opencontainers.image.version'];
  if (ref?.repository && version) return `${ref.repository}:${version}`;
  return service.config.image;
};

const wanted = {
  image: service.config.image,
  region: service.region,
  env,
  files: Object.fromEntries(
    Object.entries(FILES).map(([guest, path]) => [guest, readFileSync(path, 'utf8')]),
  ),
  command: 'compact',
  schedule: 'daily',
  vm: 'shared-cpu-1x/1024',
};
const fingerprint = createHash('sha256').update(JSON.stringify(wanted)).digest('hex').slice(0, 16);

const current = machines.filter((m) => m.config?.metadata?.hfos_role === 'compact');
if (current.length === 1 && current[0].config.metadata.hfos_settings === fingerprint) {
  console.log(`The compaction machine (${current[0].id}) already matches the service.`);
  process.exit(0);
}
for (const m of current) fly(['machine', 'destroy', m.id, '--app', APP, '--force']);
fly([
  'machine',
  'run',
  launchImage(),
  'compact',
  '--app',
  APP,
  '--name',
  'compact',
  '--region',
  wanted.region,
  '--schedule',
  wanted.schedule,
  '--restart',
  'no',
  '--vm-size',
  'shared-cpu-1x',
  '--vm-memory',
  '1024',
  '--metadata',
  'hfos_role=compact',
  '--metadata',
  `hfos_settings=${fingerprint}`,
  ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
  ...Object.entries(FILES).flatMap(([guest, path]) => ['--file-local', `${guest}=${path}`]),
  '--detach',
]);
console.log(
  `${current.length ? 'Replaced' : 'Created'} the compaction machine: it runs \`compact\` about once a day.`,
);
