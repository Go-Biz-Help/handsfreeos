/**
 * Makes the download the web app hands out (docs/outreach.md, decision 60): a build of the extension that talks to the
 * same HandsFreeOS as the web app, zipped into the web app's `public/downloads/hfos-social.zip`. The web app's `build`
 * and `dev` run it first, from apps/web, so every deploy hands out the extension as that deploy's code has it, and
 * nobody releases anything by hand.
 *
 *   node ../extension/scripts/download.mjs production     from apps/web; `development` for next dev
 *
 * Where it signs in and saves are the web app's own settings, read as Next.js reads them: the environment first (Vercel
 * sets them there), then `.env.<mode>.local`, `.env.local`, `.env.<mode>` and `.env` in the folder it runs from. So a
 * deploy hands out an extension for HandsFreeOS itself, and the local stack one for the local stack. Without the
 * Supabase address and publishable key the extension couldn't sign in, so it stops, as the web app would.
 *
 * The zip has manifest.json at its top, as Load unpacked needs, and keeps its name from version to version: Chrome knows
 * an extension loaded by hand by its folder, so unzipping a newer one over the same folder keeps the person signed in.
 * Each file is dated the same, so the same build makes the same zip.
 */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = process.cwd();
const mode = process.argv[2] === 'development' ? 'development' : 'production';
const zipFile = join(web, 'public/downloads/hfos-social.zip');
/** 1 Jan 1980, the earliest a zip can say: every file the same, so the same build makes the same zip. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** The names are UTF-8. */
const UTF8 = 0x0800;

/** The web app's settings, highest first as Next.js has them: the environment, then its .env files. */
function webSettings() {
  const files = [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'];
  const settings = {};
  for (const name of files.reverse()) {
    const path = join(web, name);
    if (existsSync(path)) Object.assign(settings, parseEnv(readFileSync(path, 'utf8')));
  }
  return { ...settings, ...process.env };
}

const settings = webSettings();
const supabaseUrl = settings.NEXT_PUBLIC_SUPABASE_URL;
const key = settings.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!supabaseUrl || !key) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY isn’t set (run `pnpm env:local`), so the extension the web app hands out couldn’t sign in.',
  );
  process.exit(1);
}

/** The same addresses the web app calls, with its fallbacks (apps/web/src/lib/env.ts). */
const config = {
  HFOS_API_URL: settings.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000',
  HFOS_WORKER_URL: settings.NEXT_PUBLIC_WORKER_URL || 'http://127.0.0.1:4100',
  // Where the extension opens the setup. Vercel doesn't set it, so a deploy's is HandsFreeOS's own address.
  HFOS_WEB_URL:
    settings.NEXT_PUBLIC_APP_URL ||
    (mode === 'development' ? 'http://localhost:3000' : 'https://app.handsfreeos.com'),
  HFOS_SUPABASE_URL: supabaseUrl,
  HFOS_SUPABASE_PUBLISHABLE_KEY: key,
};

/** Every file under `dir`, its path inside the zip with forward slashes, in a fixed order. */
function filesIn(dir, top = dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return filesIn(path, top);
      return [{ name: relative(top, path).split(sep).join('/'), data: readFileSync(path) }];
    });
}

// Built aside, so a developer's own dist/chrome, loaded in their Chrome, stays as they built it.
const built = mkdtempSync(join(tmpdir(), 'hfos-social-'));
let files;
try {
  // Quiet unless it fails: the web app's build log gets the one line below.
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs'), `--out=${built}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...config },
  });
  if (build.status !== 0) {
    process.stderr.write(`${build.stdout}${build.stderr}`);
    throw new Error('The extension didn’t build, so there’s nothing to hand out.');
  }
  files = filesIn(built);
} finally {
  rmSync(built, { recursive: true, force: true });
}
if (!files.some((f) => f.name === 'manifest.json')) {
  console.error(
    'The extension’s build has no manifest.json at its top, so there’s nothing to hand out.',
  );
  process.exit(1);
}
const made = zip(files);
mkdirSync(dirname(zipFile), { recursive: true });
writeFileSync(zipFile, made);
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(
  `HandsFreeOS Social ${version} for ${config.HFOS_API_URL}: public/downloads/hfos-social.zip (${Math.round(made.length / 1024)} KB).`,
);

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
    local.writeUInt16LE(0, 10);
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
    entry.writeUInt16LE(0, 12);
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
