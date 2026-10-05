#!/usr/bin/env node
/**
 * Builds the Chrome extension into dist/chrome: its three scripts bundled by esbuild, the panel's page and styles,
 * the icons, and manifest.json with the version from package.json. Load dist/chrome with "Load unpacked" on
 * chrome://extensions (README.md).
 *
 *   node scripts/build.mjs           build once
 *   node scripts/build.mjs --watch   build, then again on every change
 *
 * Where it signs in and saves comes from HFOS_API_URL, HFOS_WEB_URL, HFOS_SUPABASE_URL and
 * HFOS_SUPABASE_PUBLISHABLE_KEY, in the environment or in .env.local or .env beside package.json (`pnpm env:local`
 * writes .env.local for your own computer). Left out, it's HandsFreeOS itself, and without the publishable key the
 * build reads pages and doesn't sign in.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/chrome');
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
  webUrl: setting('HFOS_WEB_URL', 'https://app.handsfreeos.com'),
  supabaseUrl: setting('HFOS_SUPABASE_URL', 'https://ybupfghakoszfcxhyrby.supabase.co'),
  supabasePublishableKey: setting('HFOS_SUPABASE_PUBLISHABLE_KEY', ''),
};

/** The only site the extension works on, and the only one it reads. */
const FACEBOOK = ['https://www.facebook.com/*', 'https://web.facebook.com/*'];
/** HandsFreeOS's API and its sign-in, which the background worker calls. Any port: a local API has one. */
const HFOS = [
  ...new Set(
    [config.apiUrl, config.supabaseUrl].map((url) => {
      const { protocol, hostname } = new URL(url);
      return `${protocol}//${hostname}/*`;
    }),
  ),
];
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
  description:
    'Works beside you on Facebook: reads the page you have open and saves the people and chats you pick to HandsFreeOS. A test build.',
  minimum_chrome_version: '116',
  icons: ICONS,
  action: { default_title: 'HandsFreeOS Social', default_icon: ICONS },
  side_panel: { default_path: 'panel.html' },
  background: { service_worker: 'background.js' },
  // The side panel, its setting and the sign-in, and loading the reader into Facebook tabs opened before the
  // extension was.
  permissions: ['sidePanel', 'storage', 'scripting'],
  host_permissions: [...FACEBOOK, ...HFOS],
  content_scripts: [{ matches: FACEBOOK, js: ['content.js'], run_at: 'document_idle' }],
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: {
    content: 'src/content.ts',
    background: 'src/background.ts',
    panel: 'src/panel/panel.ts',
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
  console.log(`Built HandsFreeOS Social ${version} in dist/chrome, saving to ${config.apiUrl}.`);
  if (!config.supabasePublishableKey)
    console.log(
      'No HFOS_SUPABASE_PUBLISHABLE_KEY, so this build reads pages and can’t sign in (README.md).',
    );
}
