#!/usr/bin/env node
/**
 * Builds the Chrome extension into dist/chrome: its four scripts bundled by esbuild, the panel's page and styles, the
 * offscreen page that reads Facebook's file, the icons, and manifest.json with the version from package.json. Load
 * dist/chrome with "Load unpacked" on chrome://extensions (README.md).
 *
 *   node scripts/build.mjs               build once
 *   node scripts/build.mjs --watch       build, then again on every change
 *   node scripts/build.mjs --out=<dir>   build into another folder (the download the web app hands out does)
 *
 * Where it signs in and saves comes from HFOS_API_URL, HFOS_WORKER_URL, HFOS_WEB_URL, HFOS_SUPABASE_URL and
 * HFOS_SUPABASE_PUBLISHABLE_KEY, in the environment or in .env.local or .env beside package.json (`pnpm env:local`
 * writes .env.local for your own computer). Left out, it's HandsFreeOS itself, and without the publishable key the
 * build reads pages and doesn't sign in.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const out = outArg ? resolve(root, outArg.slice('--out='.length)) : join(root, 'dist/chrome');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

/** KEY=value lines from a file, when it's there. */
function envFile(name) {
  const path = join(root, name);
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, '$2')]),
  );
}

const settings = { ...envFile('.env'), ...envFile('.env.local'), ...process.env };
const setting = (name, otherwise) => (settings[name] || otherwise).replace(/\/+$/, '');

/** Where this build signs in and saves (src/hfos/config.ts). The key is public, like the web app's. */
const config = {
  apiUrl: setting('HFOS_API_URL', 'https://api.handsfreeos.com'),
  workerUrl: setting('HFOS_WORKER_URL', 'https://hooks.handsfreeos.com'),
  webUrl: setting('HFOS_WEB_URL', 'https://app.handsfreeos.com'),
  supabaseUrl: setting('HFOS_SUPABASE_URL', 'https://ybupfghakoszfcxhyrby.supabase.co'),
  supabasePublishableKey: setting('HFOS_SUPABASE_PUBLISHABLE_KEY', ''),
};

/**
 * Facebook, the network the extension has always worked on: its sites from install (src/networks/facebook/kit.ts says
 * the same; test/manifest.test.ts holds the two together).
 */
const FACEBOOK = ['https://www.facebook.com/*', 'https://web.facebook.com/*'];
/** Accounts Center, where Facebook makes the person's download file (src/networks/facebook/fetch.ts). */
const ACCOUNTS_CENTER = ['https://accountscenter.facebook.com/*'];
/**
 * The other networks' sites, from install too (decision 85 in docs/outreach.md, extension 0.88.0): LinkedIn, then
 * Instagram and Alignable. Chrome no longer asks for each when it's turned on. Their script still runs only while each
 * is on in HandsFreeOS, registered then (src/networks/scripts.ts), never listed in `content_scripts`, and nothing of
 * the extension's is ever web-accessible: LinkedIn's pages look for extensions by the files they show.
 */
const NETWORKS = [
  'https://www.linkedin.com/*',
  'https://www.instagram.com/*',
  // Instagram's own Accounts Center, where its username and name change (decision 89, from 0.94.0).
  'https://accountscenter.instagram.com/*',
  'https://www.alignable.com/*',
];
/**
 * The person's own files, which Chrome opens to the extension only once they turn on **Allow access to file URLs**:
 * the zips Facebook gave them, read where Chrome downloaded them (src/hfos/files.ts).
 */
const FILES = ['file:///*'];
/** HandsFreeOS's API, its worker and its sign-in, which the background worker calls. Any port: a local API has one. */
const HFOS = [
  ...new Set(
    [config.apiUrl, config.workerUrl, config.supabaseUrl].map((url) => {
      const { protocol, hostname } = new URL(url);
      return `${protocol}//${hostname}/*`;
    }),
  ),
];
/**
 * The public half of the extension's own key (scripts/public-key.pem), so Chrome gives it the same id from whatever
 * folder it's loaded from (decision 85). Without it, Chrome makes a hand-loaded extension's id from its folder: a zip
 * unzipped somewhere new is a new extension, with nothing kept, and HandsFreeOS saw a new computer each time. Its id
 * is gdgihcnpgggcaijdhnfnkfcfmhpmailc (test/manifest.test.ts). The private half isn't kept: nothing is packed with it.
 * The manifest takes it as one line of base64, without the PEM's first and last lines.
 */
const PUBLIC_KEY = readFileSync(join(root, 'scripts/public-key.pem'), 'utf8')
  .replace(/-----[A-Z ]+-----/g, '')
  .replace(/\s/g, '');
const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

const manifest = {
  manifest_version: 3,
  name: 'HandsFreeOS Social (test)',
  short_name: 'HFOS Social',
  version,
  key: PUBLIC_KEY,
  // The stores take 132 characters at most.
  description:
    'Works on Facebook, LinkedIn, Instagram and Alignable as set in HandsFreeOS: notes your steps and does what you ask. Test build.',
  minimum_chrome_version: '116',
  icons: ICONS,
  action: { default_title: 'HandsFreeOS Social', default_icon: ICONS },
  side_panel: { default_path: 'panel.html' },
  background: { service_worker: 'background.js' },
  // The side panel, its setting and the sign-in, loading the reader into Facebook tabs opened before the extension
  // was, finding the zips Facebook gave the person among Chrome's downloads, and waking the runner that works on its
  // own at its times (src/auto/run.ts); Chrome's pop-ups about what waits for the person (src/hfos/waiting.ts); and the
  // offscreen page that reads the zips when the person asks for their file to be brought in (src/jobs/file-in.ts); and
  // whether the person is away from their computer, as a read that needs the screen waits for that (src/away.ts).
  permissions: [
    'sidePanel',
    'storage',
    'scripting',
    'downloads',
    'alarms',
    'notifications',
    'offscreen',
    'idle',
  ],
  host_permissions: [...FACEBOOK, ...ACCOUNTS_CENTER, ...NETWORKS, ...HFOS, ...FILES],
  content_scripts: [
    { matches: [...FACEBOOK, ...ACCOUNTS_CENTER], js: ['content.js'], run_at: 'document_idle' },
  ],
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: {
    content: 'src/content.ts',
    background: 'src/background.ts',
    panel: 'src/panel/panel.ts',
    offscreen: 'src/offscreen.ts',
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  charset: 'utf8',
  legalComments: 'none',
  // Readable, so anyone can check what it does: the stores allow that and forbid hiding it.
  minify: false,
  define: { __HFOS_CONFIG__: JSON.stringify(config) },
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'public'), out, { recursive: true });
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
  console.log(
    `Built HandsFreeOS Social ${version} in ${relative(root, out)}, saving to ${config.apiUrl}.`,
  );
  if (!config.supabasePublishableKey)
    console.log(
      'No HFOS_SUPABASE_PUBLISHABLE_KEY, so this build reads pages and can’t sign in (README.md).',
    );
}
