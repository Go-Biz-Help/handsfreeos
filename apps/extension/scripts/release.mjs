/**
 * Puts a build of the extension where HandsFreeOS hands it out (docs/outreach.md, decision 60): the web app's
 * `public/downloads/hfos-social.zip`, which the setup's install step and Settings → Your computer link to, and the
 * version they say beside it (`packages/core/src/addons/outreach/extension-release.ts`).
 *
 *   HFOS_SUPABASE_PUBLISHABLE_KEY=sb_publishable_… pnpm --filter @hfos/extension release
 *
 * It builds for HandsFreeOS itself, whatever .env.local says, so a build made on a laptop never points at it. The
 * key is the web app's public one; without it the build couldn't sign in, so it stops. The zip has manifest.json at
 * its top, as Load unpacked needs, and its name stays the same from version to version: Chrome knows an extension
 * loaded by hand by its folder, so unzipping a newer one over the same folder keeps the person signed in. Each file
 * is dated the same, so the same build makes the same zip.
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '../..');
const built = join(root, 'dist/chrome');
const downloads = join(repo, 'apps/web/public/downloads');
const releaseFile = join(repo, 'packages/core/src/addons/outreach/extension-release.ts');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** HandsFreeOS itself: the build script's own defaults, set here so .env.local can't change them. */
const LIVE = {
  HFOS_API_URL: 'https://api.handsfreeos.com',
  HFOS_WORKER_URL: 'https://hooks.handsfreeos.com',
  HFOS_WEB_URL: 'https://app.handsfreeos.com',
  HFOS_SUPABASE_URL: 'https://ybupfghakoszfcxhyrby.supabase.co',
};

const key = process.env.HFOS_SUPABASE_PUBLISHABLE_KEY ?? '';
if (!key.startsWith('sb_publishable_')) {
  console.error(
    'Set HFOS_SUPABASE_PUBLISHABLE_KEY to the web app’s publishable key (sb_publishable_…): without it the extension can’t sign in.',
  );
  process.exit(1);
}

execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ...LIVE, HFOS_SUPABASE_PUBLISHABLE_KEY: key },
});

/** Every file under `dir`, its path inside the zip with forward slashes, in a fixed order. */
function filesIn(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesIn(path));
    else out.push({ name: relative(built, path).split(sep).join('/'), data: readFileSync(path) });
  }
  return out;
}

/** 1 Jan 1980, the earliest a zip can say: every file the same, so the same build makes the same zip. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** The names are UTF-8. */
const UTF8 = 0x0800;

/** A plain zip: each file deflated when that's smaller, else stored. */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const deflated = deflateRawSync(file.data, { level: 9 });
    const method = deflated.length < file.data.length ? 8 : 0;
    const body = method === 8 ? deflated : file.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const files = filesIn(built);
if (!files.some((f) => f.name === 'manifest.json')) {
  console.error('The build has no manifest.json at its top: nothing was released.');
  process.exit(1);
}
const made = zip(files);
mkdirSync(downloads, { recursive: true });
writeFileSync(join(downloads, 'hfos-social.zip'), made);

writeFileSync(
  releaseFile,
  `/**
 * The build of the extension HandsFreeOS hands out (docs/outreach.md, decision 60), written by
 * \`pnpm --filter @hfos/extension release\` (apps/extension/scripts/release.mjs): its version, and where the web app
 * serves it. The address keeps its name from version to version, so a newer zip unzips over the same folder; the
 * version on the end only makes browsers fetch the newer one. Don't change it by hand.
 */
export const EXTENSION_RELEASE = {
  version: '${version}',
  /** On the web app, beside the page that links to it. */
  path: '/downloads/hfos-social.zip?v=${version}',
  /** How big the download is, for the line beside the button. */
  bytes: ${made.length},
} as const;
`,
);

console.log(
  `Released HandsFreeOS Social ${version}: apps/web/public/downloads/hfos-social.zip (${Math.round(made.length / 1024)} KB, ${files.length} files).`,
);
